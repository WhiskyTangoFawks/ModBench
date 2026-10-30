using System.Text;
using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.RepositoriesLib;

namespace MEditService.Http.Endpoints;

internal static class ModEndpoints
{
    public static IEndpointRouteBuilder MapModEndpoints(this IEndpointRouteBuilder app)
    {
        // A missing load order or git refuses the whole selection once; every other refusal is an item of
        // the answer.
        app.MapPost("/build", Build)
            .WithName("BuildMod")
            .WithTags("Mods")
            .WithDescription(
                "Makes each source mod's plugins and archives in its folder from its source: its assets copied, each plugin compiled, " +
                "and each archive packed from the assets and the taken files it is handed, a taken file it packs leaving the folder. " +
                "A file of the source's under an excluded path is written under the exclusion mark, and no asset replaces a taken file. " +
                "A mod is refused before it writes, or lands naming each file it replaced that held other bytes, what failed when a " +
                "read or write stopped it part way, and each file it made with whether the source vouches for it. " +
                "Progress is the build-progress notification.")
            .Produces<BuildResult>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/decompile-and-commit", DecompileAndCommit)
            .WithName("DecompileAndCommitMod")
            .WithTags("Mods")
            .WithDescription(
                "Puts each mod under git (ADR-0007): a repository in its source folder holding the plugin source of every " +
                "plugin it provides, the assets it is handed, read from its folder, and the manifest it is handed, in one commit. " +
                "A mod lands or is refused whole. Progress is the decompile-and-commit-progress notification.")
            .Produces<DecompileAndCommitResult>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        return app;
    }

    // decompile-and-commit: the selection (commands.md, A selection is one gesture); the load order says each mod's plugins and folder.
    internal static async Task<IResult> DecompileAndCommit(DecompileAndCommitRequest req, DecompileAndCommitModHandler decompileAndCommitModHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return EndpointMapping.BadRequest("At least one mod is required.");
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || !mod.Repository.IsWhole))
            return EndpointMapping.BadRequest(NewRepositoryRequest.NotWhole);

        return await EndpointMapping.Answered(
            "Decompile and commit", logger,
            decompileAndCommitModHandler.DecompileAndCommitAsync([.. mods.Select(mod => new ModToDecompileAndCommit(mod.Name, mod.Repository.ToNewRepository()))]),
            EndpointMapping.Refusal);
    }

    // build-mod: the selection (commands.md, A selection is one gesture).
    internal static async Task<IResult> Build(BuildRequest req, BuildModHandler buildModHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return EndpointMapping.BadRequest("At least one mod is required.");
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.SourceFolder) || string.IsNullOrWhiteSpace(mod.Folder)))
        {
            return EndpointMapping.BadRequest("Every mod needs a name, a source folder and a folder.");
        }
        if (mods.Any(mod => !FolderPaths.AreInTheFolder([
            .. mod.Exclude ?? [], .. mod.Taken ?? [], .. (mod.Archives ?? []).SelectMany(archive => (IEnumerable<string>)[archive.Path, .. archive.Files ?? []])])))
        {
            return EndpointMapping.BadRequest("Every path a mod excludes, takes or packs is a forward-slash path in its folder.");
        }
        if (string.IsNullOrWhiteSpace(req.ExclusionMark))
            return EndpointMapping.BadRequest("The mod manager's exclusion mark is required.");
        var variants = req.Archives?.Variants();
        if (req.Archives is not null && variants is null) return EndpointMapping.BadRequest(ArchiveVariantsRequest.NotOneEach);

        return await EndpointMapping.Answered(
            "Build", logger,
            buildModHandler.BuildAsync(
                [.. mods.Select(mod => new ModToBuild(mod.Name, mod.SourceFolder, mod.Folder)
                {
                    Exclude = mod.Exclude ?? [],
                    Archives = [.. (mod.Archives ?? []).Select(archive => new ArchiveToPack(archive.Path, archive.Files ?? []))],
                    Taken = mod.Taken ?? [],
                })],
                new InstanceToBuild(req.ExclusionMark, variants)),
            EndpointMapping.Refusal);
    }
}

internal static class FolderPaths
{
    /// <summary>Each a forward-slash path that stays inside the folder.</summary>
    internal static bool AreInTheFolder(IEnumerable<string?> paths) =>
        paths.All(path => path is not null && !path.Contains('\\', StringComparison.Ordinal) && !Path.IsPathRooted(path)
            && path.Split('/').All(segment => !string.IsNullOrWhiteSpace(segment) && segment is not ("." or "..")));
}

/// <summary>The mods to build with the instance's facts (ADR-0013): the exclusion mark, and the archive variants, if any.</summary>
internal sealed record BuildRequest(IReadOnlyList<BuildModRequest> Mods, string ExclusionMark, ArchiveVariantsRequest? Archives);

/// <summary>A mod, the source folder that builds it, its folder, and what the extension hands its build (ADR-0016). Taken:
/// each file the extension wrote into the folder from a package, by its path there.</summary>
internal sealed record BuildModRequest(
    string Name, string SourceFolder, string Folder, IReadOnlyList<string>? Exclude = null, IReadOnlyList<ArchiveRequest>? Archives = null,
    IReadOnlyList<string>? Taken = null);

/// <summary>An archive by its path in the mod folder, and the files it takes.</summary>
internal sealed record ArchiveRequest(string Path, IReadOnlyList<string> Files);

/// <summary>The variant an archive of textures packs as, and the one every other archive packs as.</summary>
internal sealed record ArchiveVariantsRequest(ArchiveVariantRequest General, ArchiveVariantRequest Textures)
{
    internal const string NotOneEach = "Each archive variant is a BA2 or a BSA, not both.";

    /// <summary>The variants; null when either is not one BA2 or one BSA.</summary>
    internal ArchiveVariants? Variants() =>
        General?.Variant(Ba2Contents.General) is { } general && Textures?.Variant(Ba2Contents.Textures) is { } textures
            ? new ArchiveVariants(general, textures)
            : null;
}

/// <summary>A BA2 or a BSA variant.</summary>
internal sealed record ArchiveVariantRequest(Ba2VariantRequest? Ba2, BsaVariantRequest? Bsa)
{
    internal IArchiveVariant? Variant(Ba2Contents contents) => (Ba2, Bsa) switch
    {
        ({ } ba2, null) => new Ba2Variant(ba2.Version, contents, ba2.Compressed),
        (null, { } bsa) => new BsaVariant(bsa.Version, bsa.ArchiveFlags, bsa.FileFlags),
        _ => null,
    };
}

internal sealed record Ba2VariantRequest(uint Version, bool Compressed);

internal sealed record BsaVariantRequest(uint Version, uint ArchiveFlags, uint FileFlags);

/// <summary>The mods to decompile and commit (ADR-0013).</summary>
internal sealed record DecompileAndCommitRequest(IReadOnlyList<DecompileAndCommitModRequest> Mods);

/// <summary>A mod by name, and the repository its decompile and commit makes.</summary>
internal sealed record DecompileAndCommitModRequest(string Name, NewRepositoryRequest Repository);

/// <summary>The source folder a mod's repository is made in, and what the extension hands its first commit (ADR-0016): its
/// assets by their forward-slash paths in its folder, and its manifest's file name and text.</summary>
internal sealed record NewRepositoryRequest(string SourceFolder, IReadOnlyList<string>? Assets, string ManifestName, string Manifest)
{
    internal const string NotWhole =
        "A new repository needs its source folder, forward-slash paths in the mod folder for its assets, and its manifest with its file name.";

    internal bool IsWhole =>
        !string.IsNullOrWhiteSpace(SourceFolder) && FolderPaths.AreInTheFolder(Assets ?? []) && Manifest is not null
        && ManifestName is not null && FolderPaths.AreInTheFolder([ManifestName]) && !ManifestName.Contains('/', StringComparison.Ordinal)
        && RepositoriesLib.ManifestName.Is(ManifestName);

    internal NewRepository ToNewRepository() =>
        new(SourceFolder, Assets ?? [], new SpelledManifest(ManifestName, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(Manifest)));
}
