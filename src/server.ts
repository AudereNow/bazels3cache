import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { Upload } from "@aws-sdk/lib-storage";
import { S3 } from "@aws-sdk/client-s3";
import * as debug_ from "debug";
import * as minimist from "minimist";
import * as mkdirp from "mkdirp";
import * as rimraf from "rimraf";
import * as winston from "winston";
import { Args, Config, getConfig, validateConfig } from "./config";
import { Cache } from "./memorycache";
import { debug } from "./debug";
import getRawBody from "raw-body";

// just the ones we need...
enum StatusCode {
    OK = 200,
    Forbidden = 403,
    NotFound = 404,
    MethodNotAllowed = 405,
    InternalServerError = 500,
}

function timeSinceMs(startTime: Date): number {
    const endTime = new Date();
    return (endTime.getTime() - startTime.getTime());
}

function logProps(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    attrs: {
        startTime: Date,
        s3RequestDurationMs: number,
        responseLength: number,
        fromCache?: boolean,
        isBlockedGccDepfile?: boolean,
        awsPaused: boolean
    }
) {
    const loglineItems = [
        req.method,
        req.url,
        res.statusCode,
        attrs.responseLength,
        `${timeSinceMs(attrs.startTime)}ms`,
        `${attrs.s3RequestDurationMs}ms`,
        attrs.fromCache && "(from cache)",
        attrs.awsPaused && "(aws paused)",
        attrs.isBlockedGccDepfile && "(blocked gcc depfile)"
    ]
    const logline = loglineItems
        .filter(item => ["string","number"].indexOf(typeof item) !== -1)
        .join(" ");
    debug(logline);
    winston.info(logline);
}

function sendResponse(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Buffer | string | number,
    attrs: {
        startTime: Date,
        s3RequestDurationMs: number,
        fromCache?: boolean,
        isBlockedGccDepfile?: boolean,
        awsPaused: boolean
    }
) {
    let responseLength: number;
    if (body instanceof Buffer) {
        responseLength = body.byteLength;
    } else if (typeof body === "string") {
        responseLength = body.length;
    } else if (typeof body === "number") {
        responseLength = body;
    } else {
        responseLength = 0;
    }

    logProps(req, res, {
        startTime: attrs.startTime,
        s3RequestDurationMs: attrs.s3RequestDurationMs,
        responseLength,
        fromCache: attrs.fromCache,
        awsPaused: attrs.awsPaused,
        isBlockedGccDepfile: attrs.isBlockedGccDepfile
    });
    if (!res.writableEnded) { 
        res.end.apply(res, (body instanceof Buffer || typeof body === "string") ? [body] : []);
    } else {
        winston.warn("Client closed connection before we could respond.")
    }

    if (res.statusCode === StatusCode.InternalServerError) {
        winston.error("Unrecoverable Error, shutting down");
        process.exit();
    }
}

function isIgnorableError(err: any) {
    // TODO add a comment explaining this
    return err.retryable === true;
}

function isExpiredTokenError(err: any) {
    return err.Code === "ExpiredToken";
}

function shouldIgnoreError(err: any, config: Config) {
    return config.allowOffline && isIgnorableError(err);
}

function getHttpResponseStatusCode(
    err: any,
    codeIfIgnoringError: StatusCode,
    config: Config
) {
    if (isExpiredTokenError(err)) {
        return StatusCode.InternalServerError;
    } else if (shouldIgnoreError(err, config)) {
        return codeIfIgnoringError;
    } else {
        return err.statusCode || StatusCode.NotFound;
    }
}

function prepareErrorResponse(
    res: http.ServerResponse,
    err: any,
    codeIfIgnoringError: StatusCode,
    config: Config
) {
    res.statusCode = getHttpResponseStatusCode(err, codeIfIgnoringError, config);
    res.setHeader("Content-Type", "application/json");
    res.write(JSON.stringify(err, null, "  "));
}

function pathToUploadCache(s3key: string, config: Config) {
    return path.join(config.asyncUpload.cacheDir, s3key);
}

export function startServer(s3: S3, config: Config, onDoneInitializing: () => void) {
    const cache = new Cache(config); // in-memory cache
    let idleTimer: NodeJS.Timer;
    let awsPauseTimer: NodeJS.Timer;
    let awsErrors = 0;
    let awsPaused = false;
    let pendingUploadBytes = 0;

    function onAWSError(req: http.IncomingMessage, s3error: any) {
        const message = `${req.method} ${req.url}: ${s3error.message || s3error.code}`;
        debug(message);
        winston.error(message);
        winston.verbose(JSON.stringify(s3error, null, "  "));
        if (!isExpiredTokenError(s3error) && ++awsErrors >= config.errorsBeforePausing) {
            winston.warn(`Encountered ${awsErrors} consecutive AWS errors; pausing AWS access for ${config.pauseMinutes} minutes`);
            awsPaused = true;
            awsPauseTimer = setTimeout(() => {
                winston.warn("Unpausing AWS access; attempting to resume normal caching");
                awsPaused = false;
                awsErrors = 0;
                awsPauseTimer = null;
            }, config.pauseMinutes * 60 * 1000);
            awsPauseTimer.unref(); // prevent this timer from delaying shutdown
        }
    }

    function onAWSSuccess() {
        awsErrors = 0;
    }

    function clearAsyncUploadCache() {
        rimraf.sync(config.asyncUpload.cacheDir);
    }

    function shutdown(logMessage: string) {
        if (logMessage) {
            winston.info(logMessage);
        }

        // Delete all temp files that are waiting to be uploaded
        clearAsyncUploadCache();

        // We have to forcefully shut down, because we were told to do so, and who knows
        // what other background tasks might currently be taking place, e.g. various
        // uploads to S3.
        process.exit();
    }

    function safeUnlinkSync(pth: string) {
        try {
            fs.unlinkSync(pth);
        } catch (e) {
            winston.error(e);
        }
    }

    function isGccDepfile(body: Buffer) {
        return body.length <= 100000 && body.indexOf(".o: \\") >= 0;
    }

    // We are starting up; if there are any left-over temp files that were supposed to be
    // uploaded by the previous instance of the bazels3cache, delete them
    clearAsyncUploadCache();

    const server = http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
        res.setTimeout(config.socketTimeoutSeconds * 1000, () => {
            // Oh well, we can't wait forever bail out on this request and close the socket
            winston.warn("Socket timeout reached. Returning NotFound");
            res.statusCode = StatusCode.NotFound;
            sendResponse(req, res, null, {startTime, s3RequestDurationMs: 0, awsPaused });
        });

        if (idleTimer) {
            clearTimeout(idleTimer);
        }
        if (config.idleMinutes) {
            idleTimer = setTimeout(() => {
                shutdown(`Idle for ${config.idleMinutes} minutes; terminating`);
            }, config.idleMinutes * 60 * 1000);
            idleTimer.unref(); // prevent this timer from delaying shutdown
        }

        const startTime = new Date();
        const s3key = req.url.slice(1); // remove leading "/"

        switch (req.method) {
            case "GET": {
                if (s3key === "ping") {
                    sendResponse(req, res, "pong", { startTime, s3RequestDurationMs: 0, awsPaused });
                } else if (s3key === "shutdown") {
                    sendResponse(req, res, "shutting down", { startTime, s3RequestDurationMs: 0, awsPaused });
                    shutdown("Received 'GET /shutdown'; terminating");
                } else if (cache.contains(s3key)) {
                    // we already have it in our in-memory cache
                    sendResponse(req, res, cache.get(s3key), {
                        startTime,
                        s3RequestDurationMs: 0,
                        fromCache: true,
                        awsPaused
                    });
                } else if (awsPaused) {
                    res.statusCode = StatusCode.NotFound;
                    sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
                } else {
                    const s3RequestStartTime = new Date();
                    const s3request = s3.getObject({
                         Bucket: config.bucket,
                         Key: config.s3Prefix + s3key
                    });

                    s3request
                        .then(data => {
                            const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);

                            data.Body.transformToByteArray().then(arr => {
                                const buffer = new Buffer(arr);
                                if (!config.allowGccDepfiles && isGccDepfile(buffer)) {
                                    res.statusCode = StatusCode.NotFound;
                                    sendResponse(req, res, null, { startTime, s3RequestDurationMs, awsPaused, isBlockedGccDepfile: true });
                                } else {
                                    cache.maybeAdd(s3key, buffer); // safe cast?
                                    sendResponse(req, res, buffer, { // safe cast?
                                        startTime,
                                        s3RequestDurationMs,
                                        awsPaused
                                    });
                                }
                                onAWSSuccess();
                            });
                        })
                        .catch((err: any) => {
                            const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);

                            // 404 is not an error; it just means we successfully talked to S3
                            // and S3 told us there was no such item.
                            if (err.Code === "NoSuchKey") {
                                onAWSSuccess();
                            } else {
                                onAWSError(req, err);
                            }
                            // If the error is an ignorable one (e.g. the user is offline), then
                            // return 404 Not Found.
                            prepareErrorResponse(res, err, StatusCode.NotFound, config);
                            sendResponse(req, res, null, { startTime, s3RequestDurationMs, awsPaused });
                        });
                }
                break;
            }

            case "PUT": {
                if (req.url === "/") {
                    res.statusCode = StatusCode.Forbidden;
                    sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
                } else {
                    const pth = pathToUploadCache(s3key, config);
                    if (fs.existsSync(pth)) {
                        // We are apparently already uploading this file. Don't try to start a
                        // second upload of the same file.
                        res.statusCode = StatusCode.OK;
                        sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
                        return;
                    }
                    mkdirp.sync(path.dirname(pth));
                    req.pipe(fs.createWriteStream(pth)).on("close", () => {
                        let size: number;
                        try {
                            size = fs.statSync(pth).size;
                        } catch (e) {
                            // This should not happen, but we have seen it on testville
                            winston.error(e);
                            sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
                            return;
                        }
                        if (awsPaused) {
                            res.statusCode = StatusCode.OK;
                            sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
                            safeUnlinkSync(pth);
                        } else if (config.maxEntrySizeBytes !== 0 && size > config.maxEntrySizeBytes) {
                            // The item is bigger than we want to allow in our S3 cache.
                            winston.info(`Not uploading ${s3key}, because size ${size} exceeds maxEntrySizeBytes ${config.maxEntrySizeBytes}`);
                            res.statusCode = StatusCode.OK; // tell Bazel the PUT succeeded
                            sendResponse(req, res, size, { startTime, s3RequestDurationMs: 0, awsPaused });
                            safeUnlinkSync(pth);
                        } else if (pendingUploadBytes + size > config.asyncUpload.maxPendingUploadMB * 1024 * 1024) {
                            winston.info(`Not uploading ${s3key}, because there are already too many pending uploads`);
                            res.statusCode = StatusCode.OK; // tell Bazel the PUT succeeded
                            sendResponse(req, res, size, { startTime, s3RequestDurationMs: 0, awsPaused });
                            safeUnlinkSync(pth);
                        } else {
                            pendingUploadBytes += size;
                            const streamedBody = fs.createReadStream(pth);
                            const s3RequestStartTime = new Date();
                            const s3request = new Upload({
                                client: s3,

                                params: {
                                    Bucket: config.bucket,
                                    Key: config.s3Prefix + s3key,
                                    Body: streamedBody,
                                    // Very important: The bucket owner needs full control of the uploaded
                                    // object, so that they can share the object with all the appropriate
                                    // users
                                    ACL: "bucket-owner-full-control"
                                }
                            }).done();
                            s3request
                                .then(() => {
                                    const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);
                                    if (!config.asyncUpload.enabled) {
                                        sendResponse(req, res, size, { startTime, s3RequestDurationMs, awsPaused });
                                    }
                                    onAWSSuccess();
                                })
                                .catch((err: any) => {
                                    const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);
                                    onAWSError(req, err);
                                    if (!config.asyncUpload.enabled) {
                                        // If the error is an ignorable one (e.g. the user is offline), then
                                        // return 200 OK -- pretend the PUT succeeded.
                                        prepareErrorResponse(res, err, StatusCode.OK, config);
                                        sendResponse(req, res, size, { startTime, s3RequestDurationMs, awsPaused });
                                    }
                                })
                                .then(() => {
                                    pendingUploadBytes -= size;
                                    safeUnlinkSync(pth);
                                });

                            if (config.asyncUpload.enabled) {
                                // Send the response back immediately, even though the upload to S3 has not
                                // taken place yet. This allows Bazel to remain unblocked while large uploads
                                // take place.
                                //
                                // We don't know if the upload will succeed or fail; we just say it succeeded.
                                sendResponse(req, res, size, { startTime, s3RequestDurationMs: 0, awsPaused });
                            }
                        }
                    });
                }
                break;
            }

            case "HEAD": {
                if (cache.contains(s3key)) {
                    sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, fromCache: true, awsPaused });
                } else if (awsPaused) {
                    res.statusCode = StatusCode.NotFound;
                    sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
                } else {
                    const s3RequestStartTime = new Date();
                    const s3request = s3.headObject({
                         Bucket: config.bucket,
                         Key: config.s3Prefix + s3key
                    });

                    s3request
                        .then(data => {
                            const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);
                            sendResponse(req, res, null, { startTime, s3RequestDurationMs, awsPaused });
                            onAWSSuccess();
                        })
                        .catch((err: any) => {
                            const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);
                            onAWSError(req, err);
                            // If the error is an ignorable one (e.g. the user is offline), then
                            // return 404 Not Found.
                            prepareErrorResponse(res, err, StatusCode.NotFound, config);
                            sendResponse(req, res, null, { startTime, s3RequestDurationMs, awsPaused });
                        });
                }
                break;
            }

            case "DELETE": {
                cache.delete(s3key);

                const s3RequestStartTime = new Date();
                const s3request = s3.deleteObject({
                    Bucket: config.bucket,
                    Key: config.s3Prefix + s3key
                });

                s3request
                    .then(() => {
                        const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);
                        onAWSSuccess();
                        sendResponse(req, res, null, { startTime, s3RequestDurationMs, awsPaused });
                    })
                    .catch((err: any) => {
                        const s3RequestDurationMs = timeSinceMs(s3RequestStartTime);
                        onAWSError(req, err);
                        prepareErrorResponse(res, err, StatusCode.NotFound, config);
                        sendResponse(req, res, null, { startTime, s3RequestDurationMs, awsPaused });
                    });
                break;
            }

            default: {
                res.statusCode = StatusCode.MethodNotAllowed;
                sendResponse(req, res, null, { startTime, s3RequestDurationMs: 0, awsPaused });
            }
        }
    });

    server.on("error", (e) => {
        const message = `could not start server: ${e.message}`;
        winston.error(message);
        console.error(`bazels3cache: ${message}`);
        process.exitCode = 1;
    });

    server.listen(config.port, config.host, () => {
        const logfile = path.resolve(config.logging.file);
        debug(`started server at http://${config.host}:${config.port}/`);
        winston.info(`started server at http://${config.host}:${config.port}/`);
        console.log(`bazels3cache: started server at http://${config.host}:${config.port}/, logging to ${logfile}`);
        onDoneInitializing();
    });
}
