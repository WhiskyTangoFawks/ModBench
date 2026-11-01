using System.Text;
using MEditService.Commands;
using MEditService.Commands.Build;
using MEditService.ModFolderAdapter;
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
                "Runs one built-in step of each source mod's build file: a decompile of plugins in its source folder into their plugin " +
                "source, a compile of plugins into its folder, a copy of files or folders from its source folder into its folder, or a " +
                "pack of loose files of its folder into archives, which takes them out of the folder. A file written under an excluded " +
                "path is written under the exclusion mark. A mod is refused before it writes, or lands naming what failed when a read " +
                "or write stopped it part way, and each file it made with whether the source vouches for it. " +
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
                "plugin it provides, the assets it is handed, read from its folder, and the build file it is handed, in one commit. " +
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
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || mod.Repository.WhyNotWhole == NewRepositoryRequest.NotWhole))
            return EndpointMapping.BadRequest(NewRepositoryRequest.NotWhole);
        if (mods.Any(mod => mod.Repository.WhyNotWhole == NewRepositoryRequest.ManifestLacksItsFile))
            return EndpointMapping.BadRequest(NewRepositoryRequest.ManifestLacksItsFile);
        if (mods.Any(mod => mod.Repository.WhyNotWhole == NewRepositoryRequest.ManifestLacksItsText))
            return EndpointMapping.BadRequest(NewRepositoryRequest.ManifestLacksItsText);
        if (mods.Any(mod => mod.Repository.WhyNotWhole == NewRepositoryRequest.ManifestFileIsAPath))
            return EndpointMapping.BadRequest(NewRepositoryRequest.ManifestFileIsAPath);

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
        List<ModToBuild> toBuild = [];
        foreach (var mod in mods)
        {
            if (mod.Step?.ToStep() is not { } step) return EndpointMapping.BadRequest(BuildStepRequest.NotOneStep);
            if (!FolderPaths.AreInTheFolder([.. mod.Exclude ?? [], .. mod.Step.Paths()]))
                return EndpointMapping.BadRequest("Every path a mod excludes or its step names is a forward-slash path in its folder.");
            toBuild.Add(new ModToBuild(mod.Name, mod.SourceFolder, mod.Folder, step) { Exclude = mod.Exclude ?? [] });
        }
        if (string.IsNullOrWhiteSpace(req.ExclusionMark))
            return EndpointMapping.BadRequest("The mod manager's exclusion mark is required.");
        var variants = req.Archives?.Variants();
        if (req.Archives is not null && variants is null) return EndpointMapping.BadRequest(ArchiveVariantsRequest.NotOneEach);

        return await EndpointMapping.Answered(
            "Build", logger, buildModHandler.BuildAsync(toBuild, new InstanceToBuild(req.ExclusionMark, variants)), EndpointMapping.Refusal);
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

/// <summary>A mod, the source folder that builds it, its folder, what its folder excludes, and the step of its build file to
/// run (ADR-0016).</summary>
internal sealed record BuildModRequest(string Name, string SourceFolder, string Folder, BuildStepRequest? Step, IReadOnlyList<string>? Exclude = null);

/// <summary>One built-in step of a build file: exactly one of its members, each naming at least one path.</summary>
internal sealed record BuildStepRequest(
    IReadOnlyList<string>? Decompile = null, IReadOnlyList<string>? Compile = null, IReadOnlyList<string>? Copy = null,
    IReadOnlyList<ArchiveRequest>? Pack = null)
{
    internal const string NotOneStep =
        "Every mod names one step: a decompile, a compile, a copy or a pack, each of at least one path, each plugin at the root.";

    internal BuildStep? ToStep() => (Decompile, Compile, Copy, Pack) switch
    {
        ([_, ..] decompile, null, null, null) when AtTheRoot(decompile) => new BuildStep.Decompile(decompile),
        (null, [_, ..] compile, null, null) when AtTheRoot(compile) => new BuildStep.Compile(compile),
        (null, null, [_, ..] copy, null) => new BuildStep.Copy(copy),
        (null, null, null, [_, ..] pack) when pack.All(archive => archive.Files is [_, ..]) =>
            new BuildStep.Pack([.. pack.Select(archive => new ArchiveToPack(archive.Path, archive.Files))]),
        _ => null,
    };

    internal IEnumerable<string?> Paths() =>
        [.. Decompile ?? [], .. Compile ?? [], .. Copy ?? [], .. (Pack ?? []).SelectMany(archive => (IEnumerable<string?>)[archive.Path, .. archive.Files ?? []])];

    private static bool AtTheRoot(IReadOnlyList<string?> plugins) => plugins.All(plugin => plugin?.Contains('/', StringComparison.Ordinal) == false);
}

/// <summary>An archive by its path in the mod folder, and the loose files it packs there.</summary>
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
/// assets by path, its build file's text, and its manifest's name and text.</summary>
internal sealed record NewRepositoryRequest(
    string SourceFolder, IReadOnlyList<string>? Assets, string BuildFile, string? ManifestFile = null, string? Manifest = null,
    IReadOnlyList<string>? Ignored = null)
{
    internal const string NotWhole =
        "A new repository needs its source folder, forward-slash paths in the mod folder for its assets, and its build file.";

    internal string? WhyNotWhole =>
        !string.IsNullOrWhiteSpace(SourceFolder) && FolderPaths.AreInTheFolder(Assets ?? []) && BuildFile is not null
            ? WhyManifestIsNotWhole
            : NotWhole;

    internal const string ManifestLacksItsFile = "A manifest needs its file name: ManifestFile is missing.";
    internal const string ManifestLacksItsText = "A manifest needs its text: Manifest is missing.";
    internal const string ManifestFileIsAPath = "ManifestFile must be a bare file name, not a path.";

    private string? WhyManifestIsNotWhole => (ManifestFile, Manifest) switch
    {
        (null, null) => null,
        (null, _) => ManifestLacksItsFile,
        (_, null) => ManifestLacksItsText,
        var (file, _) when !IsBareFileName(file) => ManifestFileIsAPath,
        _ => null,
    };

    private static bool IsBareFileName(string name) =>
        !string.IsNullOrWhiteSpace(name) && name is not ("." or "..") && name.IndexOfAny(['/', '\\']) < 0;

    internal NewRepository ToNewRepository() =>
        new(SourceFolder, Assets ?? [], Utf8(BuildFile), ManifestFile is { } name && Manifest is { } text ? new RootFile(name, Utf8(text)) : null, Ignored);

    private static byte[] Utf8(string text) => new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(text);
}
