<form component="search/form" id="search-form" class="d-flex align-items-center" role="search" method="GET" action="{config.relative_path}/search">
	<!-- 保留原生搜索组件，常驻输入框复用快捷结果及回车搜索逻辑。 -->
	<div component="search/fields" id="search-fields">
		<div class="input-group flex-nowrap">
			<input autocomplete="off" type="search" class="form-control" placeholder="搜索主题或内容" aria-label="搜索主题或内容" name="query" value="">
			<button type="submit" class="btn btn-outline-secondary" aria-label="搜索"><i class="fa fa-search fa-fw" aria-hidden="true"></i></button>
		</div>
		<div id="quick-search-container" class="quick-search-container dropdown-menu d-block mt-2 hidden">
			<div class="form-check filter-category mb-2 ms-4">
				<input class="form-check-input" type="checkbox" checked>
				<label class="form-check-label name"></label>
			</div>
			<div class="text-center loading-indicator"><i class="fa fa-spinner fa-spin"></i></div>
			<div class="quick-search-results-container"></div>
		</div>
	</div>
</form>
