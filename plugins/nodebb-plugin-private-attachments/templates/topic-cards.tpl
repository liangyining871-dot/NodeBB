<ul component="category" class="topic-list topic-card-grid list-unstyled" id="topics-container">
	<meta itemprop="itemListOrder" content="descending">
	{{{ each topics }}}
	<li component="category/topic" class="category-item topic-card card {{{ if ./unread }}}unread{{{ end }}} {{{ if ./deleted }}}deleted{{{ end }}} {{{ if ./pinned }}}pinned{{{ end }}} {{{ if ./locked }}}locked{{{ end }}} {{{ if ./scheduled }}}scheduled{{{ end }}}" itemprop="itemListElement" <!-- IMPORT partials/data/category.tpl -->>
		<a id="{./index}" data-index="{./index}" component="topic/anchor"></a>
		<meta itemprop="name" content="{./title}">
		{{{ if showSelect }}}<i class="fa fa-square-o topic-card-select" component="topic/select" aria-label="选择主题"></i>{{{ end }}}
		<div class="topic-card-content">
			<a component="topic/header" class="topic-card-title topic-title" href="{{{ if ./externalLink }}}{./externalLink.url}{{{ else }}}{config.relative_path}/topic/{./slug}{{{ end }}}" {{{ if ./externalLink }}}target="_blank" rel="noopener noreferrer"{{{ end }}} title="{./title}" itemprop="url">{{{ if ./txTitle }}}{{tx(./title)}}{{{ else }}}{./title}{{{ end }}}</a>
			<div class="topic-card-category">
				<a href="{config.relative_path}/recent?cid={./cid}">{./category.name}</a>
				{{{ if ./externalLink }}}<span class="topic-card-external-badge"><i class="fa fa-external-link" aria-hidden="true"></i> 外部链接</span>{{{ end }}}
				<i component="topic/pinned" class="fa fa-thumb-tack {{{ if !./pinned }}}hidden{{{ end }}}" title="置顶"></i>
				<i component="topic/locked" class="fa fa-lock {{{ if !./locked }}}hidden{{{ end }}}" title="已锁定"></i>
				<i component="topic/scheduled" class="fa fa-clock-o {{{ if !./scheduled }}}hidden{{{ end }}}" title="定时发布"></i>
				{{{ if ./deleted }}}<span>已删除</span>{{{ end }}}
			</div>
			<div class="topic-card-body {{{ if ./mediaPreview }}}topic-card-body-media{{{ end }}}">
				<p class="topic-card-excerpt">{{{ if ./externalLink }}}{./externalLink.description}{{{ else }}}{{{ if ./teaser.content }}}{./teaser.content}{{{ else }}}&nbsp;{{{ end }}}{{{ end }}}</p>
				{{{ if ./externalLink }}}<a class="topic-card-body-link" href="{./externalLink.url}" target="_blank" rel="noopener noreferrer" aria-label="打开外部链接：{./title}"></a>{{{ end }}}
				{{{ if ./mediaPreview }}}
				<a class="topic-card-cover category-media-preview" href="{{{ if ./externalLink }}}{./externalLink.url}{{{ else }}}{config.relative_path}/topic/{./slug}{{{ end }}}" {{{ if ./externalLink }}}target="_blank" rel="noopener noreferrer"{{{ end }}} data-document-src="{./mediaPreview.documentUrl}" data-video-src="{./mediaPreview.videoUrl}" aria-label="查看主题媒体">
					<img src="{./mediaPreview.url}" alt="{./mediaPreview.name}" loading="lazy" />
					{{{ if ./mediaPreview.isVideo }}}<span class="category-media-play" aria-hidden="true">▶</span>{{{ end }}}
				</a>
				{{{ end }}}
			</div>
			<div class="topic-card-author">
				<a class="text-truncate" href="{{{ if ./user.userslug }}}{config.relative_path}/user/{./user.userslug}{{{ else }}}#{{{ end }}}">{{buildAvatar(./user, "24px", true)}} <span>{./user.username}</span></a>
				<span class="timeago small" title="{{{ if ./teaser.timestampISO }}}{./teaser.timestampISO}{{{ else }}}{./timestampISO}{{{ end }}}"></span>
			</div>
			<div class="topic-card-stats">
				<span title="{{tx("global:posts")}}">{{{ if ./externalLink }}}<a href="{config.relative_path}/topic/{./slug}" title="查看论坛主题，可在主题中编辑或讨论"><i class="fa fa-comment-o" aria-hidden="true"></i> 讨论 / 详情</a>{{{ else }}}<i class="fa fa-comment-o" aria-hidden="true"></i> {humanReadableNumber(./postcount)} {{tx("global:posts")}}{{{ end }}}</span>
				<span title="{{tx("global:views")}}"><i class="fa fa-eye" aria-hidden="true"></i> {humanReadableNumber(./viewcount)} {{tx("global:views")}}</span>
				{{{ if ./mainPid }}}
				<button type="button" class="topic-card-vote {{{ if ./cardVote.upvoted }}}upvoted{{{ end }}}" data-vote-pid="{./mainPid}" data-upvoted="{./cardVote.upvoted}" data-downvoted="{./cardVote.downvoted}" aria-pressed="{{{ if ./cardVote.upvoted }}}true{{{ else }}}false{{{ end }}}" aria-label="{{{ if ./cardVote.upvoted }}}取消点赞{{{ else }}}点赞{{{ end }}}" title="{{{ if ./cardVote.upvoted }}}取消点赞{{{ else }}}点赞{{{ end }}}"><i class="fa fa-thumbs-o-up" aria-hidden="true"></i> <span class="topic-card-vote-count" data-votes="{./votes}">{humanReadableNumber(./votes)}</span></button>
				{{{ else }}}
				<span title="{{tx("global:votes")}}"><i class="fa fa-thumbs-o-up" aria-hidden="true"></i> {humanReadableNumber(./votes)}</span>
				{{{ end }}}
			</div>
		</div>
	</li>
	{{{ end }}}
</ul>
