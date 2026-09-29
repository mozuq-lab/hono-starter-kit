import type { ProjectDto } from "@starter/contracts";
import { Link } from "react-router";

export function ProjectsView({
  projects,
}: {
  projects: readonly ProjectDto[];
}) {
  return (
    <main>
      <div className="projects-heading">
        <h1>Projects</h1>
        <Link className="projects-create-link" to="/projects/new">
          Create Project
        </Link>
      </div>
      {projects.length === 0 ? (
        <p>Project はまだありません。</p>
      ) : (
        <ul className="project-list">
          {projects.map((project) => (
            <li key={project.id}>
              <article className="project-card">
                <h2>
                  <Link to={`/projects/${encodeURIComponent(project.id)}`}>
                    {project.name}
                  </Link>
                </h2>
                <p>
                  <span className="project-status">{project.status}</span>
                </p>
                <time dateTime={project.updatedAt}>{project.updatedAt}</time>
              </article>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
