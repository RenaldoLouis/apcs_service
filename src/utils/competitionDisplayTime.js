// Presentation only: never use the returned text as a session/seat/checkout key.
const isDisplayTime = value => typeof value === 'string'
  && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value)
  && value.slice(0, 5) < value.slice(6);

function getCompetitionDisplayTime(event, venue, date, time) {
  const configured = (event?.venues || []).find(item => item.id === venue)?.sessions?.[date] || [];
  const special = [...(event?.orchestraSessions || []), ...(event?.masterclassSessions || [])]
    .some(item => item.venue === venue && item.date === date && item.time === time);
  if (!configured.includes(time) || special) return time;
  const revision = event?.competitionTimeDisplay?.times?.[`${venue}_${date}_${time}`];
  return isDisplayTime(revision) ? revision : time;
}

module.exports = { isDisplayTime, getCompetitionDisplayTime };
