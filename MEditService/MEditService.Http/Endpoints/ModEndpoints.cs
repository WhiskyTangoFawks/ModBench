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

        app.MapPost("/version-in-git", VersionInGit)
            .WithName("VersionInGit")
            .WithTags("Mods")
            .WithDescription(
                "Puts each mod under git (ADR-0007): its source folder, in a repository of its own or the modlist repository it sits in, holding " +
                "the plugin source of every plugin it provides, the assets it is handed, read from its folder, and the build file it is handed, " +
                "committed when asked: in a new repository to main, in the modlist repository only the source folder's paths. " +
                "A mod lands or is refused whole. Progress is the version-in-git-progress notification.")
            .Produces<VersionInGitResult>()
            .ProducesProblem(400)
            .ProducesProblem(500)
            .ProducesProblem(503);

        return app;
    }

    // version-in-git: the selection (commands.md, A selection is one gesture); the load order says each mod's plugins and folder.
    internal static async Task<IResult> VersionInGit(VersionInGitRequest req, VersionInGitHandler versionInGitHandler, ILoggerFactory loggerFactory)
    {
        var logger = loggerFactory.CreateLogger(nameof(ModEndpoints));
        var mods = req.Mods ?? [];
        if (mods.Count == 0)
            return EndpointMapping.BadRequest("At least one mod is required.");
        if (mods.Any(mod => string.IsNullOrWhiteSpace(mod.Name) || string.IsNullOrWhiteSpace(mod.ModFolder) || mod.Repository.WhyNotWhole == NewRepositoryRequest.NotWhole))
            return EndpointMapping.BadRequest(NewRepositoryRequest.NotWhole);
        if (mods.Any(mod => mod.Commit is null))
            return EndpointMapping.BadRequest(ModToVersionInGitRequest.LacksCommit);
        if (mods.Any(mod => mod.Repository.WhyNotWhole == NewRepositoryRequest.ManifestLacksItsFile))
            return EndpointMapping.BadRequest(NewRepositoryRequest.ManifestLacksItsFile);
        if (mods.Any(mod => mod.Repository.WhyNotWhole == NewRepositoryRequest.ManifestLacksItsText))
            return EndpointMapping.BadRequest(NewRepositoryRequest.ManifestLacksItsText);
        if (mods.Any(mod => mod.Repository.WhyNotWhole == NewRepositoryRequest.ManifestFileIsAPath))
            return EndpointMapping.BadRequest(NewRepositoryRequest.ManifestFileIsAPath);
        List<ModToVersionInGit> toVersion = [];
        foreach (var mod in mods)
        {
            if (mod.In is not { } heldIn) return EndpointMapping.BadRequest(ModToVersionInGitRequest.LacksIn);
            toVersion.Add(new ModToVersionInGit(mod.Name, mod.ModFolder, mod.Repository.ToNewRepository(), heldIn, mod.Commit == true));
        }

        return await EndpointMapping.Answered("Version in git", logger, versionInGitHandler.VersionInGitAsync(toVersion), EndpointMapping.Refusal);
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
            if (!FolderPaths.AreInTheFolder([.. mod.Exclude ?? [], .. mod.Ignore ?? [], .. mod.Step.Paths()]))
                return EndpointMapping.BadRequest("Every path a mod excludes or ignores, or its step names, is a forward-slash path in its folder.");
            toBuild.Add(new ModToBuild(mod.Name, mod.SourceFolder, mod.Folder, step) { Exclude = mod.Exclude ?? [], Ignore = mod.Ignore ?? [] });
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

/// <summary>A mod, the source folder that builds it, its folder, what its folder excludes and what its manifest ignores, and
/// the step of its build file to run (ADR-0016).</summary>
internal sealed record BuildModRequest(
    string Name, string SourceFolder, string Folder, BuildStepRequest? Step, IReadOnlyList<string>? Exclude = null, IReadOnlyList<string>? Ignore = null);

/// <summary>One built-in step of a build file: exactly one of its members, each naming at least one path.</summary>
internal sealed record BuildStepRequest(
    IReadOnlyList<string>? Decompile = null, IReadOnlyList<string>? Compile = null, IReadOnlyList<string>? Copy = null,
    IReadOnlyList<ArchiveRequest>? Pack = null, IReadOnlyList<ArchiveRequest>? Unpack = null)
{
    internal const string NotOneStep =
        "Every mod names one step: a decompile, a compile, a copy, a pack or an unpack, each of at least one path, each plugin at the root.";

    internal BuildStep? ToStep() => (Decompile, Compile, Copy, Pack, Unpack) switch
    {
        ([_, ..] decompile, null, null, null, null) when AtTheRoot(decompile) => new BuildStep.Decompile(decompile),
        (null, [_, ..] compile, null, null, null) when AtTheRoot(compile) => new BuildStep.Compile(compile),
        (null, null, [_, ..] copy, null, null) => new BuildStep.Copy(copy),
        (null, null, null, [_, ..] pack, null) when pack.All(archive => archive.Files is [_, ..]) =>
            new BuildStep.Pack([.. pack.Select(archive => new ArchiveToPack(archive.Path, archive.Files))]),
        (null, null, null, null, [_, ..] unpack) when unpack.All(archive => archive.Files is [_, ..]) =>
            new BuildStep.Unpack([.. unpack.Select(archive => new ArchiveToUnpack(archive.Path, archive.Files))]),
        _ => null,
    };

    internal IEnumerable<string?> Paths() =>
        [.. Decompile ?? [], .. Compile ?? [], .. Copy ?? [], .. ArchivePaths(Pack), .. ArchivePaths(Unpack)];

    private static IEnumerable<string?> ArchivePaths(IReadOnlyList<ArchiveRequest>? archives) =>
        (archives ?? []).SelectMany(archive => (IEnumerable<string?>)[archive.Path, .. archive.Files ?? []]);

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

/// <summary>The mods to version in git (ADR-0013).</summary>
internal sealed record VersionInGitRequest(IReadOnlyList<ModToVersionInGitRequest> Mods);

/// <summary>A mod by name and folder, the source folder version in git makes for it, the repository that holds it, and
/// whether it commits.</summary>
internal sealed record ModToVersionInGitRequest(string Name, string ModFolder, NewRepositoryRequest Repository, bool? Commit, SourceModIn? In)
{
    internal const string LacksCommit = "A mod to version in git needs commit: true to commit what it tracks, or false to leave it uncommitted.";
    internal const string LacksIn = "A mod to version in git needs in: NewRepository or ModlistRepository.";
}

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
