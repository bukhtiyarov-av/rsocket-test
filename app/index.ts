/** Copyright (c) Facebook, Inc. and its affiliates.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * 
 * Based on https://github.com/rsocket/rsocket-js/blob/master/packages/rsocket-examples/src/SimpleCli.js 
 * with changes including migration to TypeScript and ilustration how TimeSeries subscription may work using RSocket implementation
 * 
 */

import type {
    Responder,
    ReactiveSocket,
    Payload,
    ISubscription,
} from "rsocket-types";
import { RSocketClient, MAX_STREAM_ID } from "rsocket-core";
import { RSocketServer } from "rsocket-core";
import { every, Flowable, Single } from "rsocket-flowable";

import RSocketWebSocketServer from "rsocket-websocket-server";
import RSocketWebSocketClient from "rsocket-websocket-client";
import RSocketTCPServer from "rsocket-tcp-server";
import RSocketTcpClient from "rsocket-tcp-client";

import yargs from "yargs";

const argv = yargs
    .usage("$0 --host <host> --port <port>")
    .options({
        host: {
            default: "0.0.0.0",
            describe: "server hostname.",
            type: "string",
        },
        port: {
            default: 8080,
            describe: "server port.",
            type: "string",
        },
        protocol: {
            default: "tcp",
            describe: "the protocol.",
            choices: ["ws", "tcp"],
        },
        mode: {
            default: "client",
            describe: "the protocol.",
            choices: ["client", "server"],
        },
        operation: {
            default: "stream",
            describe: "the operation to perform.",
            choices: ["none", "stream"],
        },
        payload: {
            default: "Hi!",
            describe: "the payload to send.",
            type: "string",
        },
    })
    .choices("protocol", ["ws", "tcp"])
    .help().argv;

const isClient = argv.mode === "client";
const side = isClient ? "Client" : "Server";

function make(data: string): Payload<string, string> {
    return {
        data,
        metadata: "",
    };
}

function logRequest(type: string, payload: Payload<string, string>) {
    console.log(
        `${side} got ${type} with payload: data: ${payload.data || "null"},
      metadata: ${payload.metadata || "null"}`
    );
}

// Responder class that 
class SymmetricResponder implements Responder<string, string> {
    fireAndForget: Responder<string, string>["fireAndForget"] = (payload) => {
        logRequest("fnf", payload);
    };

    requestResponse: Responder<string, string>["requestResponse"] = (
        payload
    ) => {
        logRequest("requestResponse", payload);
        return Single.error(new Error());
    };

    requestStream: Responder<string, string>["requestStream"] = (payload) => {
        const charArray = payload.data?.split("") ?? [];

        let index = 0;

        logRequest("requestStream", payload);

        return every(1000).map(() => {
            const response = make(charArray[index]);
            if (index < charArray.length - 1) index++;
            else index = 0;

            return response;
        });
    };

    requestChannel: Responder<string, string>["requestChannel"] = () => {
        return Flowable.error(new Error());
    };

    metadataPush: Responder<string, string>["metadataPush"] = (payload) => {
        logRequest("metadataPush", payload);
        return Single.error(new Error());
    };
}

type ServerOptions = {
    host: string;
    port: number;
};

function getServerTransport(protocol: string, options: ServerOptions) {
    switch (protocol) {
        case "tcp":
        default:
            return new RSocketTCPServer({ ...options });
        case "ws":
            return new RSocketWebSocketServer({ ...options });
    }
}

function doOperation(
    socket: ReactiveSocket<string, string>,
    operation: string,
    payload: string
): Flowable<Payload<string, string>> {
    switch (operation) {
        case "none":
            return Flowable.never();
        case "stream":
        default:
            console.log(`Requesting stream with payload: ${payload}`);
            return socket.requestStream({
                data: payload,
                metadata: "",
            });
    }
}

function getClientTransport(protocol: string, options: ServerOptions) {
    switch (protocol) {
        case "tcp":
        default:
            return new RSocketTcpClient({ ...options });
        case "ws":
            return new RSocketWebSocketClient({
                url: "ws://" + options.host + ":" + options.port,
                wsCreator: (url) => {
                    return new WebSocket(url);
                },
            });
    }
}

function runOperation(
    socket: ReactiveSocket<string, string>,
    options: typeof argv
) {
    let subscription: ISubscription;

    return new Promise<void>((resolve, reject) => {
        doOperation(socket, options.operation, options.payload).subscribe({
            onComplete() {
                console.log("onComplete()");
                resolve();
            },
            onError(error) {
                console.log("onError(%s)", error.message);
                reject(error);
            },
            onNext(payload) {
                console.log("onNext(%s)", payload.data);
            },
            onSubscribe(_subscription) {
                subscription = _subscription;
                subscription.request(MAX_STREAM_ID);
            },
        });
    });
}

function connect(protocol: string, options: ServerOptions) {
    const client = new RSocketClient({
        setup: {
            dataMimeType: "text/plain",
            keepAlive: 1000000, // avoid sending during test
            lifetime: 100000,
            metadataMimeType: "text/plain",
        },
        responder: new SymmetricResponder(),
        transport: getClientTransport(protocol, options),
    });
    return client.connect();
}

async function run(options: typeof argv) {
    const serverOptions = {
        host: options.host,
        port: options.port,
    };

    if (!isClient) {
        return new Promise<void>(() => {
            const server = new RSocketServer({
                getRequestHandler: (socket: ReactiveSocket<string, string>) => {
                    runOperation(socket, options);
                    return new SymmetricResponder();
                },
                transport: getServerTransport(options.protocol!, serverOptions),
            });
            server.start();

            console.log(`Server started on ${options.host}:${options.port}`);
        });
    } else {
        console.log(`Client connecting to ${options.host}:${options.port}`);
        // $FlowFixMe
        const socket: ReactiveSocket<string, string> = await connect(
            options.protocol!,
            serverOptions
        );
        socket.connectionStatus().subscribe((status) => {
            console.log("Connection status:", status);
        });

        return runOperation(socket, options);
    }
}

Promise.resolve(run(argv)).then(
    () => {
        console.log("exit");
        process.exit(0);
    },
    (error) => {
        console.error(error.stack);
        process.exit(1);
    }
);
