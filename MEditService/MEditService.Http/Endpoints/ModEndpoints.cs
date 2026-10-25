using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.SourceAdapter;

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
                "Writes each source mod's folder from its source as its build configuration says: the base from its " +
                "installation files, its assets over it, each plugin compiled, each archive packed, and its manifest last. A file the " +
                "build did not make stays. A mod is refused before it writes, or lands naming each file it replaced that held other bytes, and " +
                "what failed when a read or write stopped it part way. " +
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
                "plugin it provides, the files no installation file yields as its assets, and a build configuration naming " +
                "its folder as the output, in one commit. A mod lands or is refused whole. Progress is the decompile-and-commit-progress notification.")
            .Produces<DecompileAndCommitResult>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        app.MapPost("/build-configuration", ChangeBuildConfiguration)
            .WithName("ChangeBuildConfiguration")
            .WithTags("Mods")
            .WithDescription(
                "Writes a source mod's build configuration in its working tree, keeping all else it says: the output folder's " +
                "new name, and the paths in the mod folder its build excludes. Modbench writes the mod folder in the same gesture.")
            .Produces(204)
            .ProducesProblem(400)
            .ProducesProblem(422)
            .ProducesProblem(500);

        return app;
    }

    // decompile-and-commit: the selection (commands.md, A selection is one gesture); the load order says each mod's plugins and folder.
    internal static async Task<IResult> DecompileAndCommit(DecompileAndCommitRequest req, DecompileAndCommitModHandler decompileAndCommitModHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return EndpointMapping.BadRequest("At least one mod is required.");
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.SourceFolder)
            || (mod.MetadataFiles ?? []).Any(string.IsNullOrWhiteSpace)))
        {
            return EndpointMapping.BadRequest("Every mod needs a name and a source folder.");
        }

        return await EndpointMapping.Answered(
            "Decompile and commit", logger,
            decompileAndCommitModHandler.DecompileAndCommitAsync([.. mods.Select(mod => new ModToDecompileAndCommit(mod.Name, mod.SourceFolder, mod.MetadataFiles ?? []))]),
            EndpointMapping.Refusal);
    }

    internal static IResult ChangeBuildConfiguration(
        BuildConfigurationRequest req, ChangeBuildConfigurationHandler handler, ILoggerFactory loggerFactory)
    {
        IReadOnlyList<string> exclude = req.Exclude ?? [], include = req.Include ?? [];
        if (string.IsNullOrWhiteSpace(req.SourceFolder) || (req.Output is null && exclude.Count + include.Count == 0)
            || exclude.Concat(include).Any(path => path is null))
        {
            return EndpointMapping.BadRequest("A source folder is required, with an output, or paths to exclude or include.");
        }

        return EndpointMapping.Answered(
            "Change build configuration", loggerFactory.CreateLogger(nameof(ModEndpoints)), req.SourceFolder,
            handler.Change(req.SourceFolder, new BuildConfigurationChange(req.Output, exclude, include)));
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
        if (string.IsNullOrWhiteSpace(req.ExclusionMark))
            return EndpointMapping.BadRequest("The mod manager's exclusion mark is required.");
        if (string.IsNullOrWhiteSpace(req.StatCache)) return EndpointMapping.BadRequest("The folder of the stat cache is required.");
        var variants = req.Archives?.Variants();
        if (req.Archives is not null && variants is null) return EndpointMapping.BadRequest(ArchiveVariantsRequest.NotOneEach);

        return await EndpointMapping.Answered(
            "Build", logger,
            buildModHandler.BuildAsync(
                [.. mods.Select(mod => new ModToBuild(mod.Name, mod.SourceFolder, mod.Folder, mod.MetadataFiles ?? [], mod.Version, mod.IsSubmodule))],
                new InstanceToBuild(req.ExclusionMark, variants, req.StatCache)),
            EndpointMapping.Refusal);
    }
}

/// <summary>A source mod's folder, and what to change in its build configuration: the output folder's new name, and
/// forward-slash paths in the mod folder to exclude or include.</summary>
internal sealed record BuildConfigurationRequest(
    string SourceFolder, string? Output, IReadOnlyList<string>? Exclude, IReadOnlyList<string>? Include);

/// <summary>The mods to build with the instance's facts (ADR-0013): the mod manager's exclusion mark, the game's
/// archive variants, if any, and the stat cache's folder.</summary>
internal sealed record BuildRequest(IReadOnlyList<BuildModRequest> Mods, string ExclusionMark, ArchiveVariantsRequest? Archives, string StatCache);

/// <summary>A mod by name, the source folder whose build configuration names it, its folder, its version, its metadata
/// files, which its manifest does not name, and whether the Instance adapter makes its repository a submodule (ADR-0022).</summary>
internal sealed record BuildModRequest(
    string Name, string SourceFolder, string Folder, IReadOnlyList<string> MetadataFiles, string? Version, bool IsSubmodule = false);

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

/// <summary>A mod by name, the folder its repository goes in, and the mod manager's own files in its folder, by
/// forward-slash path, which no build makes.</summary>
internal sealed record DecompileAndCommitModRequest(string Name, string SourceFolder, IReadOnlyList<string> MetadataFiles);
