import { useState } from 'react';
import type { ResearchJobStatus, ResearchJobUi } from '../../features/chat/protocol';
import { t } from '../i18n';
import { vscodeApi } from '../vscodeApi';

interface ResearchJobsPanelProps {
	jobs: ResearchJobUi[];
	// Компактный dock над composer
	compact?: boolean;
	// Показать секцию даже без jobs (Settings / multitask / project)
	forceVisible?: boolean;
	// Ключ заголовка (Settings: Teams live)
	titleKey?: string;
}

function isFinished(status: ResearchJobStatus): boolean {
	return status === 'done' || status === 'error' || status === 'aborted';
}

function isActive(status: ResearchJobStatus): boolean {
	return status === 'running' || status === 'queued';
}

function statusLabel(status: ResearchJobStatus): string {
	switch (status) {
		case 'queued':
			return t('chat.research.status.queued');
		case 'running':
			return t('chat.research.status.running');
		case 'done':
			return t('chat.research.status.done');
		case 'error':
			return t('chat.research.status.error');
		case 'aborted':
			return t('chat.research.status.aborted');
		default:
			return status;
	}
}

// Карточки research/subagent jobs: статус, interrupt, child session, worktree
export function ResearchJobsPanel({
	jobs,
	compact = false,
	forceVisible = false,
	titleKey = 'chat.research.title',
}: ResearchJobsPanelProps) {
	const [open, setOpen] = useState(true);
	const hasJobs = jobs.length > 0;
	if (!hasJobs && !forceVisible) {
		return null;
	}

	const anyRunning = jobs.some((j) => isActive(j.status));
	const runningCount = jobs.filter((j) => isActive(j.status)).length;
	const rootClass = [
		'teams-panel',
		'research-jobs',
		compact ? 'research-jobs--compact' : '',
	].filter(Boolean).join(' ');

	return (
		<section className={rootClass} aria-label={t(titleKey)}>
			<div className="teams-panel__header research-jobs__header">
				<button
					type="button"
					className="teams-panel__toggle"
					aria-expanded={open}
					onClick={() => setOpen((v) => !v)}
				>
					<span className="teams-panel__chevron" aria-hidden="true">{open ? '▾' : '▸'}</span>
					<span className="teams-panel__title research-jobs__title">{t(titleKey)}</span>
					{hasJobs ? (
						<span className="teams-panel__count research-jobs__count">
							{runningCount > 0
								? t('chat.research.runningCount', runningCount, jobs.length)
								: t('chat.research.count', jobs.length)}
						</span>
					) : (
						<span className="teams-panel__count research-jobs__count">
							{t('chat.teams.empty')}
						</span>
					)}
				</button>
				{anyRunning ? (
					<button
						type="button"
						className="btn btn--secondary research-jobs__interrupt-all"
						onClick={() => vscodeApi.postMessage({ type: 'interruptAllResearch' })}
					>
						{t('chat.research.interruptAll')}
					</button>
				) : null}
				{jobs.some((j) => Boolean(j.worktreePath) && isFinished(j.status) && !j.mutating) ? (
					<button
						type="button"
						className="btn btn--secondary"
						onClick={() =>
							vscodeApi.postMessage({ type: 'cleanupAllFinishedWorktrees' })
						}
					>
						{t('chat.research.cleanupAllWorktrees')}
					</button>
				) : null}
			</div>
			{open && hasJobs ? (
				<ul className="research-jobs__list">
					{jobs.map((job) => (
						<li
							key={job.id}
							className={`research-jobs__item research-jobs__item--${job.status}`}
						>
							<div className="research-jobs__main">
								<span
									className={`research-jobs__badge research-jobs__badge--${job.status}`}
								>
									{statusLabel(job.status)}
								</span>
								<span className="research-jobs__subagent">{job.subagent}</span>
								{job.background ? (
									<span className="research-jobs__badge research-jobs__badge--muted">
										{t('chat.research.background')}
									</span>
								) : null}
								{job.mutating ? (
									<span className="research-jobs__badge research-jobs__badge--muted">
										{t('chat.research.mutating')}
									</span>
								) : null}
							</div>
							<div className="research-jobs__preview" title={job.promptPreview}>
								{job.promptPreview}
							</div>
							{job.detail ? (
								<div className="research-jobs__detail">{job.detail}</div>
							) : null}
							{job.reportSnippet ? (
								<pre className="teams-panel__snippet research-jobs__snippet">
									{job.reportSnippet}
								</pre>
							) : null}
							<div className="research-jobs__actions">
								{isActive(job.status) ? (
									<button
										type="button"
										className="btn btn--secondary"
										onClick={() =>
											vscodeApi.postMessage({
												type: 'interruptResearchJob',
												id: job.id,
											})
										}
									>
										{t('chat.research.interrupt')}
									</button>
								) : null}
								{job.status === 'aborted' || job.status === 'error' ? (
									<button
										type="button"
										className="btn btn--secondary"
										onClick={() =>
											vscodeApi.postMessage({
												type: 'resumeResearchJob',
												id: job.id,
											})
										}
									>
										{t('chat.research.resume')}
									</button>
								) : null}
								{job.childSessionId ? (
									<button
										type="button"
										className="btn btn--secondary"
										onClick={() =>
											vscodeApi.postMessage({
												type: 'openChildSession',
												sessionId: job.childSessionId!,
											})
										}
									>
										{t('chat.research.openChild')}
									</button>
								) : null}
								<button
									type="button"
									className="btn btn--secondary"
									onClick={() =>
										vscodeApi.postMessage({
											type: 'attachResearchTranscript',
											id: job.id,
										})
									}
								>
									{t('chat.research.attach')}
								</button>
								{job.worktreePath && isFinished(job.status) ? (
									<button
										type="button"
										className="btn btn--secondary"
										onClick={() =>
											vscodeApi.postMessage({
												type: 'cleanupWorktree',
												path: job.worktreePath!,
											})
										}
									>
										{t('chat.research.cleanupWorktree')}
									</button>
								) : null}
								{job.detail && /\.haratsan[/\\]reports[/\\]/.test(job.detail) ? (
									<button
										type="button"
										className="btn btn--secondary"
										onClick={() =>
											vscodeApi.postMessage({
												type: 'openProjectReport',
												path: job.detail!,
											})
										}
									>
										{t('chat.research.openReport')}
									</button>
								) : null}
							</div>
						</li>
					))}
				</ul>
			) : null}
			{open && !hasJobs ? (
				<div className="research-jobs__empty">{t('chat.research.emptyHint')}</div>
			) : null}
		</section>
	);
}
