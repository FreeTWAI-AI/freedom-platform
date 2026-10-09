export type ChatPollSchedule={idle:number;nextAt:number};
const intervals=[1000,1000,2000,3000,5000] as const;
export const resetChatPoll=():ChatPollSchedule=>({idle:0,nextAt:0});
/** Failure retry deadlines replace the idle deadline, never get shortened by activity. */
export const chatPollDue=(schedule:ChatPollSchedule,now:number,retryAt=0)=>now>=(retryAt||schedule.nextAt);
export function idleChatPoll(schedule:ChatPollSchedule,now:number):ChatPollSchedule{
  const idle=Math.min(schedule.idle+1,intervals.length);
  return {idle,nextAt:now+intervals[idle-1]};
}
