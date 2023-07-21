import fs from "fs";
import child_process from "child_process";
import http from "http";
import https from "https";
import { S3 } from "@aws-sdk/client-s3";
import { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import { fromIni } from "@aws-sdk/credential-providers";
import debug_ from "debug";
import minimist from "minimist";
import winston from "winston";
import { Args, Config, getConfig, validateConfig } from "./config";
import { Cache } from "./memorycache";
import { debug } from "./debug";
import { startServer } from "./server";
import { initLogging } from "./logging";

function fatalError(error: string) {
    console.error(`bazels3cache: ${error}`); // the user should see this
    winston.error(error);                    // this goes to the log
    process.exitCode = 1;
}

function daemonMain(args: Args, onDoneInitializing: () => void) {
    process.on("uncaughtException", function (err) {
        fatalError(""+err);
        process.exit(1); // hard stop; can't rely on just process.exitCode
    });

    const config = getConfig(args);
    initLogging(config); // Do this early, because when logging doesn't work, we're flying blind
    validateConfig(config); // throws if config is invalid

    let credentials = fromIni();
    let s3 = new S3({ credentials });
    startServer(s3, config, onDoneInitializing);
}

function main(args: string[]) {
    const DONE_INITIALIZING = "done_initializing";

    // When bazels3cache launches, it spawns a child bazels3cache with "--daemon"
    // added to the command line.
    //
    // The parent process then waits until that child process either exits, or sends
    // us a "done_initializing" message. Then the parent process exits.
    if (args.indexOf("--daemon") === -1) {
        // We are parent process
        const devnull = fs.openSync("/dev/null", "r+");
        // As described here https://github.com/nodejs/node/issues/17592, although
        // child_process.fork() doesn't officially support `detached: true`, it works
        const child = child_process.fork(__filename, ["--daemon"].concat(args),
            <any>{ detached: true });

        // This is so that if we terminate *without* receiving a "done_initializig"
        // message from the child process, that's because the child process
        // terminated unexpectedly, so we should exit with an error code.
        //
        // While we're waiting, the child process still has stdout and stderr, and
        // can send any messages to there.
        process.exitCode = 1;

        child.on("message", msg => {
            if (msg === DONE_INITIALIZING) {
                child.unref(); // don't wait for the child process to terminate
                child.disconnect(); // don't wait on the ipc channel any more
                process.exitCode = 0; // now we can exit cleanly
            }
        });
    } else {
        // child process
        daemonMain(minimist<Args>(args), () => {
            // Now that the daemon has finished initializing, we need to:
            // - close stdin, stdout, and stderr, so that we don't keep these handles
            //   open cause problems
            // - open /dev/null for all three of those
            // - send a "done_initializing" message to our parent process.

            fs.closeSync(0);
            fs.closeSync(1);
            fs.closeSync(2);
            // Odd: If I don't do the following, then sometimes writes such as
            // console.log() still show up on the screen. I don't get it.
            process.stdout.write = process.stderr.write = (): undefined => undefined;
            fs.openSync("/dev/null", "r+"); // stdin
            fs.openSync("/dev/null", "r+"); // stdout
            fs.openSync("/dev/null", "r+"); // stderr

            // Tells the parent that we initialized successfully and it can exit
            process.send(DONE_INITIALIZING);
        });
    }
}

main(process.argv.slice(2));
