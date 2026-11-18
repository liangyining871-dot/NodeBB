'use strict';

async function decorateCardVotes(data, posts) {
	const topics = (data.topics || []).filter(topic => topic?.mainPid);
	if (!topics.length) { return data; }
	const status = await posts.getVoteStatusByPostIDs(topics.map(topic => topic.mainPid), data.uid);
	topics.forEach((topic, index) => {
		topic.cardVote = { upvoted: Boolean(status.upvotes[index]), downvoted: Boolean(status.downvotes[index]) };
	});
	return data;
}

module.exports = { decorateCardVotes };
