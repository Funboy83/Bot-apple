// Daily checking window, including overnight windows. No Apple request outside it.
export function withinCheckingHours(check, date = new Date()) {
  if (!check.scheduleEnabled) return true;
  const fields = new Intl.DateTimeFormat('en-GB', {
    timeZone: check.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const time = `${fields.find((p) => p.type === 'hour').value}:${fields.find((p) => p.type === 'minute').value}`;
  return check.startTime < check.endTime
    ? time >= check.startTime && time < check.endTime
    : time >= check.startTime || time < check.endTime;
}
