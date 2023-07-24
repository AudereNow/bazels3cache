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

function childMain(args: Args, onDoneInitializing: () => void) {
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
    // When bazels3cache launches, it spawns a child bazels3cache with "--child"
    // added to the command line.
    //
    // The parent process then restarts the child process if it exits, allowing it
    // to reload the AWS token from the file. This was the easiest method I could
    // find to automatically reload the token file if it changes.
    if (args.indexOf("--child") === -1) {
        // We are parent process

        const child = child_process.fork(__filename, ["--child"].concat(args),
            { silent: true });

        child.stdout.on("data", data => console.log(Buffer.from(data).toString("utf-8")));
        child.on("exit", () => main(args));
    } else {
        // child process
        childMain(minimist<Args>(args), () => {});
    }
}

main(process.argv.slice(2));
