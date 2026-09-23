type Match = { id: string; data?: unknown } | undefined;

/** "Quality · Sentiment · Labeling Portal", using the project layout's data. */
export function projectTitle(matches: ReadonlyArray<Match>, page: string) {
  const layout = matches.find((m) => m?.id === 'routes/project-layout');
  const name = (layout?.data as { project?: { name?: string } } | undefined)?.project?.name;
  return [{ title: [page, name, 'Labeling Portal'].filter(Boolean).join(' · ') }];
}
