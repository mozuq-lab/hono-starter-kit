import type { ProjectDto } from "@starter/contracts";
import { Link } from "react-router";
import { statusBadgeClass } from "../../components/ui-classes.js";

export function ProjectsView({
  projects,
}: {
  projects: readonly ProjectDto[];
}) {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-extrabold tracking-tight">Projects</h1>
        <Link
          className="inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold whitespace-nowrap text-white transition-colors hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400"
          to="/projects/new"
        >
          Create Project
        </Link>
      </div>
      {projects.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          Project はまだありません。
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 sm:grid-cols-2">
          {projects.map((project) => (
            <li key={project.id}>
              <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition motion-safe:hover:-translate-y-0.5 motion-safe:hover:shadow-lg dark:border-slate-800 dark:bg-slate-900">
                <h2 className="mb-2 text-lg font-bold">
                  <Link
                    className="text-slate-900 no-underline hover:text-blue-600 hover:underline dark:text-slate-100 dark:hover:text-blue-400"
                    to={`/projects/${encodeURIComponent(project.id)}`}
                  >
                    {project.name}
                  </Link>
                </h2>
                <p className="mb-2">
                  <span className={statusBadgeClass}>{project.status}</span>
                </p>
                <time
                  className="text-xs text-slate-500 dark:text-slate-400"
                  dateTime={project.updatedAt}
                >
                  {project.updatedAt}
                </time>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
