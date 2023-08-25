// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
/*
 * Copyright IBM Corp. All Rights Reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import * as grpc from "@grpc/grpc-js";
import {
  connect,
  Contract,
  Identity,
  Signer,
  signers,
} from "@hyperledger/fabric-gateway";
import * as crypto from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import { TextDecoder } from "util";
import express from "express";
import cors from "cors";
const channelName = envOrDefault("CHANNEL_NAME", "mychannel");
const chaincodeName = envOrDefault("CHAINCODE_NAME", "basic");
const mspId = envOrDefault("MSP_ID", "Org1MSP");

// location to the crypto materials.
const cryptoPath = envOrDefault(
  "CRYPTO_PATH",
  path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "test-network",
    "organizations",
    "peerOrganizations",
    "org1.example.com"
  )
);

// locations to key of user 1.
const keyDirectoryPath = envOrDefault(
  "KEY_DIRECTORY_PATH",
  path.resolve(cryptoPath, "users", "User1@org1.example.com", "msp", "keystore")
);

// location to the user certificates
const certPath = envOrDefault(
  "CERT_PATH",
  path.resolve(
    cryptoPath,
    "users",
    "User1@org1.example.com",
    "msp",
    "signcerts",
    "cert.pem"
  )
);

// locations to the tls certificates of the peer of organisation 1
const tlsCertPath = envOrDefault(
  "TLS_CERT_PATH",
  path.resolve(cryptoPath, "peers", "peer0.org1.example.com", "tls", "ca.crt")
);

// peer endpoint of gateway
const peerEndpoint = envOrDefault("PEER_ENDPOINT", "localhost:7051");

const peerHostAlias = envOrDefault("PEER_HOST_ALIAS", "peer0.org1.example.com");

const utf8Decoder = new TextDecoder();
const assetId = `asset${Date.now()}`;
//globaly stored so these can be accessed while using the code
let client, gateway, contract;

//initializing the express framework
const app = express();

//using cors package for cross-origin call
app.use(cors());
//parsing the contents of request body
app.use(express.json());

app.get("/", async (req, res) => {
  await main();

  let response = await getAllTheAssets(contract);
  //sending all the assets
  res.status(200).json(response);
});

app.post("/asset", async (req, res) => {
  let response = await createTheAsset(contract, req.body);
  res.status(200).json(response);
});
app.put("/asset", async (req, res) => {
  let response = await transferTheAssetAsynchronously(contract, req.body);
  res.status.json(response);
});

async function main(): Promise<void> {
  await displayInputParameters();

  //creating a gRPC connection which is going to shared by the gateway
  client = await newGrpcConnection();

  //connecting the gateway
  gateway = connect({
    client,
    identity: await newIdentity(),
    signer: await newSigner(),
    // Default timeouts for different gRPC calls
    evaluateOptions: () => {
      return { deadline: Date.now() + 5000 }; // 5 seconds
    },
    endorseOptions: () => {
      return { deadline: Date.now() + 15000 }; // 15 seconds
    },
    submitOptions: () => {
      return { deadline: Date.now() + 5000 }; // 5 seconds
    },
    commitStatusOptions: () => {
      return { deadline: Date.now() + 60000 }; // 1 minute
    },
  });

  //getting the instance of the network where channel is deployed
  const network = gateway.getNetwork(channelName);

  // getting the instance of chaincode deployed on the network
  contract = network.getContract(chaincodeName);

  // initialize the ledger with some predifined assets
  await initializeTheLedger(contract);
}

//creates a gRPC connection and returns the instance
async function newGrpcConnection(): Promise<grpc.Client> {
  const tlsRootCert = await fs.readFile(tlsCertPath);
  const tlsCredentials = grpc.credentials.createSsl(tlsRootCert);
  return new grpc.Client(peerEndpoint, tlsCredentials, {
    "grpc.ssl_target_name_override": peerHostAlias,
  });
}
// returns the identity
async function newIdentity(): Promise<Identity> {
  const credentials = await fs.readFile(certPath);
  return { mspId, credentials };
}

// used for signing the transactions
async function newSigner(): Promise<Signer> {
  const files = await fs.readdir(keyDirectoryPath);
  const keyPath = path.resolve(keyDirectoryPath, files[0]);
  const privateKeyPem = await fs.readFile(keyPath);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  return signers.newPrivateKeySigner(privateKey);
}

async function initializeTheLedger(contract: Contract): Promise<void> {
  await contract.submitTransaction("InitLedger");

  console.log("*** Transaction committed successfully");
}

async function getAllTheAssets(contract: Contract): Promise<void> {
  const resultInBytes = await contract.evaluateTransaction("GetAllAssets");

  const resultJson = utf8Decoder.decode(resultInBytes);
  //converted to json
  const result = JSON.parse(resultJson);
  console.log("*** All the assets:", result);
  return result;
}

async function createTheAsset(
  contract: Contract,
  values: { id: string; value: string }
): Promise<void> {
  await contract.submitTransaction(
    "CreateAsset",
    values.id,
    values.value,
    "Org1"
  );

  console.log("*** Transaction committed successfully,Asset added ");
}

async function transferTheAssetAsynchronously(
  contract: Contract,
  data: { id: string; owner: string }
): Promise<void> {
  const commit = await contract.submitAsync("TransferAsset", {
    arguments: [data.id, data.owner],
  });
  const oldOwner = utf8Decoder.decode(commit.getResult());

  console.log(
    `*** Successfully submitted transaction to transfer ownership from ${oldOwner} to ${data.owner}`
  );

  const status = await commit.getStatus();
  if (!status.successful) {
    throw new Error(
      `Transaction ${status.transactionId} failed to commit with status code ${status.code}`
    );
  }

  console.log("*** Transaction committed successfully,Owner changed");
}

/**
 * envOrDefault() will return the value of an environment variable, or a default value if the variable is undefined.
 */
function envOrDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

// displaying all the input parameters of the network to the server log
async function displayInputParameters(): Promise<void> {
  console.log(`channelName:       ${channelName}`);
  console.log(`chaincodeName:     ${chaincodeName}`);
  console.log(`mspId:             ${mspId}`);
  console.log(`cryptoPath:        ${cryptoPath}`);
  console.log(`keyDirectoryPath:  ${keyDirectoryPath}`);
  console.log(`certPath:          ${certPath}`);
  console.log(`tlsCertPath:       ${tlsCertPath}`);
  console.log(`peerEndpoint:      ${peerEndpoint}`);
  console.log(`peerHostAlias:     ${peerHostAlias}`);
}

// this makes the server listen at port 3002
app.listen(3002, () => console.log("Fabric gateway server listening at 3002"));
