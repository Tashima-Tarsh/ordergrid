import { Queue } from "bullmq";
import { Redis } from "ioredis";
export const createOrderQueue = (redisUrl:string) => { const connection=new Redis(redisUrl,{maxRetriesPerRequest:null}); return {connection,queue:new Queue("orders",{connection})}; };
