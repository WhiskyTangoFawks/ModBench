using System.Reflection;
using System.Runtime.CompilerServices;
using MEditService.Core.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

public class RecordTextCodecGeneratorSeedTests
{
    // Asserting that Fallout4Mod_Serialization never exists does NOT work —
    // it always exists, because RecordTextCodecGeneratorSeed's own (internal, never-invoked) seed
    // necessarily names a mod-shaped argument type, which is unavoidable per the generator's own
    // design (there is no smaller seed shape — see RecordTextCodecGeneratorSeed's doc comment).
    //
    // Scoped to MEditService.Core.Serialization, not the whole assembly:
    // an unscoped version also flags DuckDbRecordIndex.Index/IRecordIndex.Index/
    // PlacementWalker.Walk, which legitimately take a mod for indexing and have nothing to do with
    // this source codec. That check holds today and goes red if this namespace's own public surface
    // ever grows a whole-mod-accepting method — including a constructor, not just a method: checked
    // separately below (GetMethods alone does not see constructors, and a later
    // `SourceWriter(IFallout4ModGetter)` is exactly the surface AC2 forbids).
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

    // The reflection check above cannot see a *call* to the generated whole-mod mixin — only a
    // public signature naming a mod type. A hypothetical
    // `RebuildAsync(string sourceDir, string outputPath)` over
    // `MutagenJsonConverterFallout4ModMixIns.DeserializeInto` would have an all-string signature and
    // stay invisible to it. So this scans source text directly: the mixin's type name may appear in
    // MEditService.Core's own .cs files only inside this whitelist of designated doors (ADR-0041:
    // "only the designated doors", never "any caller"). A call from any other file is exactly what
    // this test exists to catch.
    //
    // The rule is "add a file here only when it genuinely names the mixin", not "add every door as
    // it ships": a door that reaches the mixin only through RecordTextCodecGeneratorSeed's gateway
    // (SourceIngest.cs, SpatialContainerMint.cs) never spells the type name and needs no exemption
    // — and granting one anyway would quietly weaken the check for that file forever. The
    // gateway-method scans below are what actually cover a door's call, one per gateway method.
    //
    // Deliberately checking the type name only, not the containing namespace
    // (Mutagen.Bethesda.Serialization.Newtonsoft) as originally proposed: that namespace also holds
    // the JSON kernel types RecordTextCodec.cs legitimately imports for unrelated reasons (its own
    // `using Mutagen.Bethesda.Serialization.Newtonsoft;`), so checking the bare namespace string is a
    // false positive there, not a signal — narrowed to the one thing that is actually dangerous.
    //
    // [CallerFilePath] locates MEditService.Core relative to this test file's own compile-time
    // source path, not the test run's output directory — the existing fixtures in this suite
    // instead copy needed files into the build output (see CutDownPluginFixture), so this is a new
    // pattern for this test project: a source scan, not a build-output read. Flagged as such rather
    // than silently introduced.
    [Fact]
    public void CoreSources_NameTheWholeModMixinOnlyInTheDesignatedDoorFiles()
    {
        const string mixinTypeName = "MutagenJsonConverterFallout4ModMixIns";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "RecordTextCodecGeneratorSeed.cs", // the compile-time seed, never invoked
            "TrackService.cs",                 // Track
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

    // Companion to the check above, at the *gateway* rather than the mixin's own type name: a
    // friendly extension-method call (`MutagenJsonConverter.Instance.Serialize(...)`)
    // never actually names `MutagenJsonConverterFallout4ModMixIns` in caller source at all (C# extension
    // syntax doesn't spell the containing static class), so the scan above alone stays silent
    // for exactly the call shape a real caller would write. RecordTextCodecGeneratorSeed's own doc
    // comment already forces every real caller through `SerializeWholeMod` instead (a second direct
    // bootstrap call site does not even compile — CS8785) — this scans
    // for *that* method name instead, which every real call site's source text does spell out.
    [Fact]
    public void CoreSources_CallSerializeWholeModOnlyFromDesignatedDoorFiles()
    {
        const string gatewayMethodName = "SerializeWholeMod";
        const string gatewayFile = "RecordTextCodecGeneratorSeed.cs";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "TrackService.cs",          // Track
            "SpatialContainerMint.cs",  // exterior WRLD/CELL spatial mint
            // #631: the plugin header's own body. The header is an ordinary `records` row whose body
            // is the whole-mod door's root RecordData.json (ADR-0041 already names that file as part
            // of the source), and a ModHeader is not an IMajorRecordGetter — so the per-record codec
            // structurally cannot produce it and the only alternative to this door would be a
            // hand-rolled copy of its {ModKey, GameRelease, ModHeader} wrapper, i.e. exactly the
            // second dialect this whitelist exists to prevent. It pays the door's cost the way the
            // whitelist asks a door to: deliberately, once, and cheaply — ~1 ms, because it serializes
            // a header-only clone rather than walking the mod (HeaderDocument.Write's own comment
            // carries the measurement, and HeaderDocumentTests pins the equality that licenses it).
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

    // The same guard for the door's *read* side, and it needs to be its own test rather than a
    // second entry in the one above — the scan above is a case-sensitive Ordinal substring search for
    // "SerializeWholeMod", and "DeserializeWholeMod" does not contain it (the 'S' is lowercased by the
    // "De" prefix), so that check is structurally silent for every ingest-from-source call
    // site. Same
    // rationale as its sibling otherwise: rebuilding a whole plugin from its text source outside a
    // designated door is the wrong tool, and the right one remains per-record deserialize.
    [Fact]
    public void CoreSources_CallDeserializeWholeModOnlyFromDesignatedDoorFiles()
    {
        const string gatewayMethodName = "DeserializeWholeMod";
        const string gatewayFile = "RecordTextCodecGeneratorSeed.cs";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            "SourceIngest.cs",         // ingest-from-source
            "PluginCompileService.cs", // compile from the tree
            "TrackService.cs",         // Track's own round-trip gate reads its own tree back
            // #631: the read half of the same header door — see the write-side list above for why
            // the header cannot go through the per-record codec. Symmetric by construction: the
            // document this reads is the one HeaderDocument.Write produced, so using any other
            // reader would reintroduce the dialect split from the other end.
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

    // The guard at the bootstrap *receiver* rather than
    // at either gateway method's name.
    //
    // For the write side, "a door bypasses the gateway and calls the mixin directly" needed no test:
    // a second bootstrap-shaped call site for the same mod-typed seed does not compile (CS8785), so
    // the build itself refused it. That is no longer true for the read side. `Deserialize`'s argument 0
    // is a folder, not a Loqui type, so the generator records the invocation with a null
    // ObjectRegistration, emits nothing for it, and never reaches the hint-name collision — verified in
    // the generator's own source and then empirically (the build succeeds, one mixin, no stub). So a
    // direct `MutagenJsonConverter.Instance.Deserialize(...)` from anywhere in Core now compiles
    // cleanly, spells neither `MutagenJsonConverterFallout4ModMixIns` (extension syntax doesn't name
    // the containing class) nor `DeserializeWholeMod` — and would therefore slip past every other check
    // in this file.
    //
    // Scanning the receiver catches it, and catches the same bypass on the write side too, which was
    // only ever covered by a compiler error that happens to fire for one of the two directions.
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

    // The sequential-dropoff guard: there is a real upstream race in
    // MajorRecordListParallelHelper under a genuinely parallel IWorkDropoff (nested-list containers
    // writing into each other's folders) — TrackService passes Noggog.WorkEngine.InlineWorkDropoff.Instance
    // explicitly at its one whole-mod call site, even though it is already the library's own default,
    // precisely so a future edit swapping it for ParallelWorkDropoff is a visible, reviewable diff, not
    // a silent behavior change. This is the test that makes "visible" also mean "caught": the door file
    // may never name ParallelWorkDropoff at all.
    //
    // SourceIngest.cs is on the list too: the race is in the write-side helpers, but the read side
    // drives the same folder-split machinery over the same nested containers, so it names the same
    // sequential dropoff and is held to the same rule rather than being trusted to the library default.
    //
    // PluginCompileService.cs likewise, for the same reason as SourceIngest — it reads the
    // same trees through the same gateway.
    //
    // HeaderDocument.cs (#631) is held to the rule too, even though it cannot actually reach the
    // race: it serializes a header-only clone, so there is no nested container for the parallel
    // helpers to trip over. Listed anyway because the rule is about which files may name a parallel
    // dropoff at all, not about which ones would currently be harmed by one — a later edit that
    // handed this door a populated mod would otherwise inherit the hazard silently. Adding a file
    // here only tightens the check.
    [Fact]
    public void DoorFiles_NeverNameAParallelWorkDropoff()
    {
        const string parallelDropoffName = "ParallelWorkDropoff";
        var doorFiles = new[] { "TrackService.cs", "SourceIngest.cs", "PluginCompileService.cs", "HeaderDocument.cs" };

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

    // Companion to the two checks above, at the assembly level rather than the source level: pins
    // that the generated mixin remains the *only* public type this project's own compilation
    // produces outside its own MEditService.* namespaces. If a future package addition or seed
    // change ever generates a second alien public type, this names it instead of it going unnoticed.
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
