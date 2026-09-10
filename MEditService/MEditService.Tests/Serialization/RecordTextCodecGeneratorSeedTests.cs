using System.Reflection;
using System.Runtime.CompilerServices;
using MEditService.Core.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

public class RecordTextCodecGeneratorSeedTests
{
    // Asserting Fallout4Mod_Serialization never exists does not work: the seed necessarily names a
    // mod-shaped argument type. Scoped to MEditService.Core.Serialization, since an unscoped version
    // also flags the indexing and placement doors, which legitimately take a mod.
    [Fact]
    public void SerializationNamespace_ExposesNoPublicApiAcceptingAWholeModType()
    {
        var candidateTypes = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace == "MEditService.Core.Serialization")
            .ToList();

        // A namespace typo or a rename of RecordTextCodecCustomization's namespace would leave
        // candidateTypes empty, and every assertion below would then pass vacuously — over zero
        // types, not over the surface this test claims to guard. Assert the set is real first.
        Assert.NotEmpty(candidateTypes);

        var offendingMembers = candidateTypes
            .SelectMany(t => ((IEnumerable<MethodBase>)t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
                .Concat(t.GetConstructors(BindingFlags.Public | BindingFlags.Instance)))
            .Where(m => m.GetParameters().Any(p => typeof(IModGetter).IsAssignableFrom(p.ParameterType))
                || (m is MethodInfo mi && typeof(IModGetter).IsAssignableFrom(mi.ReturnType)))
            .Select(m => $"{m.DeclaringType!.FullName}.{m.Name}")
            .ToList();

        Assert.Empty(offendingMembers);
    }

    // The reflection check above sees only a public signature naming a mod type, never a call, so this
    // scans source text: the mixin's type name may appear only inside this whitelist of designated
    // doors (ADR-0041).
    [Fact]
    public void CoreSources_NameTheWholeModMixinOnlyInTheDesignatedDoorFiles()
    {
        const string mixinTypeName = "MutagenJsonConverterFallout4ModMixIns";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "RecordTextCodecGeneratorSeed.cs", // the compile-time seed, never invoked
            "PluginTrees.cs",                  // a plugin's binary and its tree, composed
        };

        var sourceFiles = Directory.GetFiles(CoreSourceRoot(), "*.cs", SearchOption.AllDirectories);
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

        var sourceFiles = Directory.GetFiles(CoreSourceRoot(), "*.cs", SearchOption.AllDirectories);
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
            "PluginCompileService.cs", // compile from the tree
            "PluginTrees.cs",          // a tree compiled back to bytes
            // The read half of the same header door. Symmetric by construction: the document this reads is the
            // one HeaderDocument.Write produced, so any other reader reintroduces the dialect split.
            "HeaderDocument.cs",       // the plugin header's document, both directions
        };

        var sourceFiles = Directory.GetFiles(CoreSourceRoot(), "*.cs", SearchOption.AllDirectories);
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

        var sourceFiles = Directory.GetFiles(CoreSourceRoot(), "*.cs", SearchOption.AllDirectories);
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
        var doorFiles = new[] { "TrackService.cs", "PluginCompileService.cs", "HeaderDocument.cs" };

        var sourceFiles = Directory.GetFiles(CoreSourceRoot(), "*.cs", SearchOption.AllDirectories)
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

    private static string CoreSourceRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "MEditService.Core"));
}
