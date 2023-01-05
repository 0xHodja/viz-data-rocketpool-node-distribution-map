import fetch from "node-fetch";
import fs, { read } from "fs";
import * as dotenv from "dotenv";
import { ethers } from "ethers";

dotenv.config();

const addresses = {
  RocketpoolNodeManagers: ["0x372236c940f572020c0c0eb1ac7212460e4e5a33", "0x4477Fbf4Af5b34E49662d9217681a763dDc0a322", "0x67CdE7AF920682A29fcfea1A179ef0f30F48Df3e"],
  RocketpoolDepositPool: ["0x1cc9cf5586522c6f483e84a19c3c2b0b6d027bf0", "0xdcd51fc5cd918e0461b9b7fb75967fdfd10dae2f"],
};

let contracts = {};

const API_KEY = process.env.ETHERSCAN_API_KEY;
const rateLimit = [30, 60000]; // [max calls, time in ms]
let calls = [];

const rateLimitCalls = async () => {
  calls = calls.filter((t) => t > Date.now() - rateLimit[1]);
  while (calls.length > rateLimit[0]) {
    console.log(`waiting for rate limit... ${calls.length}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 10));
    calls = calls.filter((t) => t > Date.now() - rateLimit[1]);
  }
  return;
};

// request with retries
const fetchUrl = async (url, retries = 30) => {
  await rateLimitCalls();
  calls.push(Date.now());
  let res;
  let retryStatuses = [429, 503];
  try {
    res = await fetch(url);
    if (retryStatuses.includes(res.status)) {
      if (retries > 0) {
        let waitTime = 20000 + Math.floor(Math.random() * 1000);
        console.log(url, retries, res.statusText, `Waiting ${waitTime} ms`);
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        res = await fetchUrl(url, retries - 1);
      }
    }
    return res;
  } catch (e) {
    throw e;
  }
};

// write json to file
const writeToFile = (path, content) => {
  try {
    fs.writeFileSync(path, content);
  } catch (e) {
    console.log(e);
    throw e;
  }
};

// load json to file
const readFromFileJSON = (path) => {
  let data;
  try {
    data = fs.readFileSync(path);
    data = JSON.parse(data);
  } catch (e) {
    console.log(e);
    throw e;
  }
  return data;
};

// contract ABIs
const getContractABIs = async (contractAddress) => {
  try {
    return readFromFileJSON(`./data/contractABI_${contractAddress}`);
  } catch {
    const res = await fetchUrl(`https://api.etherscan.io/api?module=contract&action=getabi&address=${contractAddress}&apikey=${API_KEY}`);
    let abi = await res.json();
    abi = abi.result;
    writeToFile(`./data/contractABI_${contractAddress}`, JSON.stringify(abi));
    return abi;
  }
};

const intialiseContractABIs = async () => {
  let contractAddresses = [];
  Object.values(addresses).map((x) => x.map((y) => contractAddresses.push(y)));
  await Promise.all(
    contractAddresses.map(async (x) => {
      contracts[x.toLowerCase()] = await getContractABIs(x);
    })
  );
};

// etherscan api
const getNormalTxs = async (contractAddress) => {
  const txNormal = await fetchUrl(`https://api.etherscan.io/api?module=account&action=txlist&address=${contractAddress}&sort=asc&apikey=${API_KEY}`);
  return txNormal;
};

// query all node registrations + all set timezone calls
const getAllNodeTimezones = async () => {
  let txns = await Promise.all(
    // query versions of rocketpool node manager contract
    Object.values(addresses.RocketpoolNodeManagers).map(async (address) => {
      let d = await getNormalTxs(address);
      let k = await d.json();
      return k;
    })
  );
  txns = txns.map((x) => x.result).reduce((a, b) => [...a, ...b], []);
  // filter register node and "set timezone"
  txns = txns.filter((x) => x.isError === "0");
  txns = txns.filter((x) => x.functionName.includes("registerNode") || x.functionName.includes("setTimezone"));
  // write updated JSON list to disk
  writeToFile("./data/transactions_node_tz.json", JSON.stringify(txns));
};

// query all minipool creations
// insert {node operator, minipool address, block, time, 1} into minpool table
const getAllMinipoolCreations = async () => {
  // query normal transactions on the node deposit pool
  let txns = await Promise.all(
    // query versions of rocketpool node manager contract
    Object.values(addresses.RocketpoolDepositPool).map(async (address) => {
      let d = await getNormalTxs(address);
      let k = await d.json();
      return k;
    })
  );
  txns = txns.map((x) => x.result).reduce((a, b) => [...a, ...b], []);
  txns = txns.filter((x) => x.isError === "0");
  txns = txns.filter((x) => x.functionName.includes("deposit"));
  writeToFile("./data/transactions_node_deposits.json", JSON.stringify(txns));
  // going to stop here as the only flaw of not continuing is we overestimate slightly by including on dissolved minipools

  // for each TX - get minipool contract
  // minipool: get "stake" transaction to find actual staking activation time
  // {node operator, block, time, }
};

// convert node operator and deposit data into a flat table of timezone changes
// {node operator, block, time UTC, timezone, change}
const compileData = () => {
  let node_tz = readFromFileJSON("./data/transactions_node_tz.json");
  let node_deposits = readFromFileJSON("./data/transactions_node_deposits.json");

  node_tz = node_tz.map((x) => {
    try {
      const abi = contracts[x.to.toLowerCase()];
      const iface = new ethers.utils.Interface(abi);
      const tz = iface.decodeFunctionData(x.functionName.split("(")[0], x.input);
      return { ...x, timezone: tz[0] };
    } catch (error) {
      console.log(error);
    }
  });

  let node_tz_inits = node_tz.filter((x) => x.functionName.includes("registerNode"));
  let node_tz_resets = node_tz.filter((x) => x.functionName.includes("setTimezone"));

  // for all node deposits, format, get tz initial
  node_deposits = node_deposits.map((x) => {
    let node_tz = node_tz_inits.filter((y) => y.from === x.from);
    if (node_tz[0] === undefined) {
      console.log(1);
    }
    return { ...x, timezone: node_tz[0].timezone, accumulator: 1 };
  });

  // for each set timezone tx,
  // for deposit txns existing before the tx, add "migrate"
  // for deposit txns existing after the tx, set to new timezone
  // O(m x n) sorry
  let tz_migrations = [];
  node_tz_resets.forEach((x) => {
    let tzBlock = parseInt(x.blockNumber);
    node_deposits.forEach((y) => {
      if (x.from === y.from) {
        if (parseInt(y.blockNumber) <= tzBlock) {
          tz_migrations.push({ ...y, blockNumber: tzBlock, timeStamp: x.timeStamp, timezone: y.timezone, accumulator: -1 });
          tz_migrations.push({ ...y, blockNumber: tzBlock, timeStamp: x.timeStamp, timezone: x.timezone, accumulator: 1 });
        } else if (parseInt(y.blockNumber) > tzBlock) {
          y.timezone = x.timezone;
        }
      }
    });
  });
  let node_tz_accumulator = [...node_deposits, ...tz_migrations];
  node_tz_accumulator = node_tz_accumulator.map((x) => {
    return { node: x.from, block: x.blockNumber, timeStamp: x.timeStamp, timezone: x.timezone, accumulator: x.accumulator };
  });

  node_tz_accumulator.sort((a, b) => (parseInt(a.block) > parseInt(b.block) ? 1 : -1));
  writeToFile("./data/node_tz_outputs.json", JSON.stringify(node_tz_accumulator));
};

(async () => {
  await intialiseContractABIs();
  //await getAllNodeTimezones();
  //await getAllMinipoolCreations();
  await compileData();
})();
