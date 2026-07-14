import { scheduleMidnightWrap } from './midnightWrap';
import { scheduleTomorrowReminder } from './tomorrowReminder';

export function startJobs(): void {
  scheduleTomorrowReminder();
  scheduleMidnightWrap();
}
