import Instance from "arangodb-instance-manager/lib/Instance";
import InstanceManager from "arangodb-instance-manager/lib/InstanceManager";
import { expect } from "chai";
import { Database } from "../arangojs";

const sleep = (timeout: number) =>
  new Promise(resolve => setTimeout(resolve, timeout));

let ARANGO_PATH: string;
let ARANGO_RUNNER: "local" | "docker";
if (process.env.RESILIENCE_ARANGO_BASEPATH) {
  ARANGO_PATH = process.env.RESILIENCE_ARANGO_BASEPATH;
  ARANGO_RUNNER = "local";
} else if (process.env.RESILIENCE_DOCKER_IMAGE) {
  ARANGO_PATH = process.env.RESILIENCE_DOCKER_IMAGE;
  ARANGO_RUNNER = "docker";
}
const describeIm = ARANGO_PATH! ? describe.only : describe.skip;

describeIm("Single-server active failover", function() {
  this.timeout(Infinity);
  let im: InstanceManager;
  let uuid: string;
  let leader: Instance;
  let db: Database;
  beforeEach(async () => {
    im = new InstanceManager(ARANGO_PATH, ARANGO_RUNNER);
    await im.startAgency();
    await im.startSingleServer("arangojs", 2);
    await im.waitForAllInstances();
    uuid = await im.asyncReplicationLeaderSelected();
    leader = await im.asyncReplicationLeaderInstance();
    db = new Database({ url: leader.endpoint });
    await db.acquireHostList();
  });
  afterEach(async () => {
    await im.cleanup();
  });
  async function getServerId(): Promise<string | undefined> {
    const res = await db.route("_api/replication/server-id").get();
    return res.body.serverId;
  }
  async function responseHeaders() {
    const res = await db.route("_api/version").get();
    return res.headers;
  }
  it("failover to follower if leader is down", async () => {
    expect((db as any)._connection._urls).to.have.lengthOf(2);
    (db as any)._connection._activeHost = 0;
    const leaderId = await getServerId();
    expect(leaderId).not.to.be.empty;
    const headers = await responseHeaders();
    expect(headers).not.to.include.keys("x-arango-endpoint");

    await im.kill(leader);
    await im.asyncReplicationLeaderSelected(uuid as any);
    await sleep(3000);
    await db.version(); // cycle

    const newLeaderId = await getServerId();
    expect(newLeaderId).not.to.be.empty;
    expect(newLeaderId).not.to.equal(leaderId);
    const newHeaders = await responseHeaders();
    expect(newHeaders).not.to.include.keys("x-arango-endpoint");
  });
  it("redirect to leader if server is not leader", async () => {
    expect((db as any)._connection._urls).to.have.lengthOf(2);
    (db as any)._connection._activeHost = 1;
    const followerId = await getServerId();
    expect(followerId).not.to.be.empty;
    const headers = await responseHeaders();
    expect(headers).to.include.keys("x-arango-endpoint");

    await im.kill(leader);
    await im.asyncReplicationLeaderSelected(uuid as any);
    await sleep(3000);

    const newLeaderId = await getServerId();
    expect(newLeaderId).not.to.be.empty;
    expect(newLeaderId).to.equal(followerId);
    const newHeaders = await responseHeaders();
    expect(newHeaders).not.to.include.keys("x-arango-endpoint");
  });
});

describeIm("Cluster round robin", function() {
  this.timeout(Infinity);
  const NUM_COORDINATORS = 3;
  let im: InstanceManager;
  let db: Database;
  beforeEach(async () => {
    im = new InstanceManager(ARANGO_PATH, ARANGO_RUNNER);
    const endpoint = await im.startCluster(1, NUM_COORDINATORS, 2);
    db = new Database({
      url: endpoint,
      loadBalancingStrategy: "ROUND_ROBIN"
    });
    await db.acquireHostList();
  });
  afterEach(async () => {
    await im.cleanup();
  });
  async function getServerId(): Promise<string | undefined> {
    const res = await db.route("_admin/status").get();
    return res.body.serverInfo && res.body.serverInfo.serverId;
  }
  it("cycles servers", async () => {
    expect((db as any)._connection._urls).to.have.lengthOf(NUM_COORDINATORS);
    const serverIds = new Set<string>();
    for (let i = 0; i < NUM_COORDINATORS; i++) {
      const serverId = await getServerId();
      expect(serverId).not.to.be.empty;
      expect(serverIds).not.to.include(serverId!);
      serverIds.add(serverId!);
    }

    expect(serverIds.size).to.equal(NUM_COORDINATORS);
    for (const serverId of serverIds) {
      const secondId = await getServerId();
      expect(secondId).to.equal(serverId);
    }
  });
  it("skips downed servers", async () => {
    expect((db as any)._connection._urls).to.have.lengthOf(NUM_COORDINATORS);
    const firstRun = new Set<string>();
    for (let i = 0; i < NUM_COORDINATORS; i++) {
      const serverId = await getServerId();
      expect(serverId).not.to.be.empty;
      firstRun.add(serverId!);
    }

    const instance = im.coordinators()[0];
    expect(instance.status).to.equal("RUNNING");
    await im.shutdown(instance);
    expect(instance.status).not.to.equal("RUNNING");

    const secondRun = new Set<string>();
    for (let i = 0; i < NUM_COORDINATORS; i++) {
      const serverId = await getServerId();
      expect(serverId).not.to.be.empty;
      secondRun.add(serverId!);
    }
    expect(firstRun.size - secondRun.size).to.equal(1);
  });
  it("it picks up restarted servers", async () => {
    expect((db as any)._connection._urls).to.have.lengthOf(NUM_COORDINATORS);
    const firstRun = new Set<string>();
    for (let i = 0; i < NUM_COORDINATORS; i++) {
      const serverId = await getServerId();
      expect(serverId).not.to.be.empty;
      firstRun.add(serverId!);
    }

    const instance = im.coordinators()[0];
    expect(instance.status).to.equal("RUNNING");
    await im.shutdown(instance);
    expect(instance.status).not.to.equal("RUNNING");
    for (let i = 0; i < NUM_COORDINATORS; i++) {
      await getServerId();
    }
    await im.restart(instance);
    expect(instance.status).to.equal("RUNNING");

    const secondRun = new Set<string>();
    for (let i = 0; i < NUM_COORDINATORS; i++) {
      const serverId = await getServerId();
      expect(serverId).not.to.be.empty;
      secondRun.add(serverId!);
    }
    expect(firstRun.size).to.equal(secondRun.size);
  });
  it("treats cursors as sticky", async () => {
    expect((db as any)._connection._urls).to.have.lengthOf(NUM_COORDINATORS);
    const LENGTH = 2;
    const cursor = await db.query(
      `FOR i IN 1..${LENGTH} RETURN i`,
      {},
      { batchSize: 1 }
    );
    const result = [];
    while (cursor.hasNext()) {
      result.push(await cursor.next());
    }
    expect(result).to.have.lengthOf(LENGTH);
  });
});
