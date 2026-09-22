using System.Reflection;
using System.Runtime.CompilerServices;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public class RecordTextCodecGeneratorSeedTests
{
    // The doors are public because the Plugin adapter is a separate assembly; BannedApiScopeTests
    // holds the package edge that stops another box calling them. This scans source text: the
    // mixin's name may appear only here (ADR-0007).
    [Fact]
    public void CoreSources_NameTheWholeModMixinOnlyInTheDesignatedDoorFiles()
    {
        const string mixinTypeName = "MutagenJsonConverterFallout4ModMixIns";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "RecordTextCodecGeneratorSeed.cs", // the compile-time seed, never invoked
            "PluginTrees.cs",                  // a plugin's binary and its tree, composed
        };

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => !designatedDoors.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f).Contains(mixinTypeName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    // C# extension syntax does not spell the containing static class, so the scan above stays silent
    // for exactly the call shape a real caller writes. This scans for the gateway method name instead,
    // which every real call site does spell.
    [Fact]
    public void CoreSources_CallSerializeWholeModOnlyFromDesignatedDoorFiles()
    {
        const string gatewayMethodName = "SerializeWholeMod";
        const string gatewayFile = "RecordTextCodecGeneratorSeed.cs";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "PluginTrees.cs",           // a plugin's binary read as its tree
            // The plugin header's own body: a ModHeader is not an IMajorRecordGetter, so the per-
            // record codec cannot produce it and the only alternative is the second dialect this
            // whitelist prevents.
            "HeaderDocument.cs",        // the plugin header's document, both directions
        };

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != gatewayFile && !designatedDoors.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f).Contains(gatewayMethodName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    // Its own test rather than a second entry above: that scan is a case-sensitive search for
    // "SerializeWholeMod", which "DeserializeWholeMod" does not contain, so it is structurally silent
    // for every ingest-from-source call site.
    [Fact]
    public void CoreSources_CallDeserializeWholeModOnlyFromDesignatedDoorFiles()
    {
        const string gatewayMethodName = "DeserializeWholeMod";
        const string gatewayFile = "RecordTextCodecGeneratorSeed.cs";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "PluginTrees.cs",          // a tree read as a mod, and compiled back to bytes
            // The read half of the same header door. Symmetric by construction: the document this reads is the
            // one HeaderDocument.Write produced, so any other reader reintroduces the dialect split.
            "HeaderDocument.cs",       // the plugin header's document, both directions
        };

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != gatewayFile && !designatedDoors.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f).Contains(gatewayMethodName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    // The guard sits at the bootstrap receiver rather than either gateway method's name because a
    // second bootstrap-shaped call site for the same mod-typed seed does not compile at all.
    [Fact]
    public void CoreSources_NameTheBootstrapReceiverOnlyInTheGatewayFile()
    {
        const string bootstrapReceiver = "MutagenJsonConverter.Instance";
        const string gatewayFile = "RecordTextCodecGeneratorSeed.cs";

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != gatewayFile)
            .Where(f => File.ReadAllText(f).Contains(bootstrapReceiver, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    // MajorRecordListParallelHelper has an upstream race under a genuinely parallel IWorkDropoff, so
    // the doors pass InlineWorkDropoff explicitly even though it is the library default, and may never
    // name ParallelWorkDropoff. Listing a file here only tightens the check.
    [Fact]
    public void DoorFiles_NeverNameAParallelWorkDropoff()
    {
        const string parallelDropoffName = "ParallelWorkDropoff";
        var doorFiles = new[] { "TrackService.cs", "PluginTrees.cs", "HeaderDocument.cs" };

        var sourceFiles = ProductionSources()
            .Where(f => doorFiles.Contains(Path.GetFileName(f)))
            .ToList();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => File.ReadAllText(f).Contains(parallelDropoffName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    // At the assembly level rather than the source level: the generated mixin must remain the only
    // public type this compilation produces outside MEditService's own namespaces.
    [Fact]
    public void CoreAssembly_HasNoOtherPublicTypeOutsideItsOwnNamespaces()
    {
        var alienPublicTypes = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace is not null && !t.Namespace.StartsWith("MEditService", StringComparison.Ordinal))
            .Select(t => t.FullName)
            .ToList();

        // Name confirmed empirically, not by naming-convention guesswork — a scratch project
        // seeded with MutagenJsonConverter.Instance.Serialize(mod, folder) and built with
        // -p:EmitCompilerGeneratedFiles=true actually emits this exact type, in this exact namespace.
        Assert.Equal(["Mutagen.Bethesda.Serialization.Newtonsoft.MutagenJsonConverterFallout4ModMixIns"], alienPublicTypes);
    }

    // Every production project: the doors the whitelists name now sit in three of them, and a scan
    // scoped to one would stop seeing the other two.
    private static readonly string[] ProductionProjects =
    [
        "MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
        "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
        "MEditService.Queries", "MEditService.SourceRepo", "MEditService.Watcher",
    ];

    private static string[] ProductionSources([CallerFilePath] string here = "")
    {
        var hereDirectory = Path.GetDirectoryName(here)
            ?? throw new InvalidOperationException($"Expected '{here}' to have a directory.");
        var solution = Path.GetFullPath(Path.Combine(hereDirectory, "..", ".."));
        return [.. ProductionProjects.SelectMany(
            project => Directory.GetFiles(Path.Combine(solution, project), "*.cs", SearchOption.AllDirectories))];
    }
}
