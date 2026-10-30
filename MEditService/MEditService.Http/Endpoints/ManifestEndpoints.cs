using MEditService.Commands.Build;
using MEditService.SourceAdapter;

namespace MEditService.Http.Endpoints;

internal static class ManifestEndpoints
{
    public static IEndpointRouteBuilder MapManifestEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/clone-submodules", CloneSubmodules)
            .WithName("CloneSubmodules")
            .WithTags("Modlist")
            .WithDescription(
                "Clones each source mod's submodule the source folder lacks at the commit the instance repository pins, on its branch " +
                "when that branch is at the pin, so restore from manifest reads the manifest it holds. Each submodule is cloned or " +
                "at its pin, named with why its branch was left elsewhere; at another commit, which it leaves as it is; or named " +
                "with why it was not cloned.")
            .Produces<CloneSubmodulesResult>()
            .ProducesProblem(400);

        return app;
    }

    internal static IResult CloneSubmodules(CloneSubmodulesRequest req, CloneSubmodulesHandler handler, ILoggerFactory loggerFactory, CancellationToken aborted) =>
        req.Submodules is { Count: > 0 } submodules && submodules.All(submodule => submodule is { IsWhole: true })
            ? EndpointMapping.Answered(
                "Clone submodules", loggerFactory.CreateLogger(nameof(ManifestEndpoints)), handler.Clone([.. submodules.Select(submodule => submodule.ToSubmodule())], aborted))
            : EndpointMapping.BadRequest("At least one submodule is required, and every submodule needs the folder git checks it out in and the commit the instance repository pins.");
}

/// <summary>A submodule as the Instance adapter reads the instance repository (ADR-0013): the folder git checks it out in, the
/// commit the instance repository pins, and the branch it follows, if any.</summary>
internal sealed record SubmoduleRequest(string Folder, string Pin, string? Branch)
{
    internal bool IsWhole => !string.IsNullOrWhiteSpace(Folder) && !string.IsNullOrWhiteSpace(Pin);

    internal Submodule ToSubmodule() => new(Folder, Pin, Branch);
}

/// <summary>The submodules to clone, as the Instance adapter reads the instance repository (ADR-0013).</summary>
internal sealed record CloneSubmodulesRequest(IReadOnlyList<SubmoduleRequest> Submodules);
