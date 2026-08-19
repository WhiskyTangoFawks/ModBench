using System.Reflection;
using System.Runtime.CompilerServices;
using MEditService.Core.Serialization;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Serialization;

public class RecordTextCodecGeneratorSeedTests
{
    // AC2 enforcement, revised from the original proposal after checking the generator's actual
    // output (#367 report): asserting that Fallout4Mod_Serialization never exists does NOT work —
    // it always exists, because RecordTextCodecGeneratorSeed's own (internal, never-invoked) seed
    // necessarily names a mod-shaped argument type, which is unavoidable per the generator's own
    // design (there is no smaller seed shape — see RecordTextCodecGeneratorSeed's doc comment).
    //
    // Scoped to this ticket's own code (MEditService.Core.Serialization), not the whole assembly:
    // an unscoped version also flags DuckDbRecordRepository.Index/IRecordIndexer.Index/
    // PlacementWalker.Walk, which legitimately take a mod for indexing and have nothing to do with
    // this ledger codec. That check holds today and goes red if this namespace's own public surface
    // ever grows a whole-mod-accepting method — including a constructor, not just a method: checked
    // separately below (GetMethods alone does not see constructors, and a later
    // `LedgerWriter(IFallout4ModGetter)` is exactly the surface AC2 forbids).
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
    // public signature naming a mod type. #381's crash-repair path adding
    // `RebuildAsync(string ledgerDir, string outputPath)` over
    // `MutagenJsonConverterFallout4ModMixIns.DeserializeInto` would have an all-string signature and
    // stay invisible to it, while shipping exactly the 21 s / 132,787-file / 106 MB path ADR-0040
    // rejected. So this scans source text directly: the mixin's type name may appear in
    // MEditService.Core's own .cs files only inside RecordTextCodecGeneratorSeed.cs, which is
    // documented and expected to name it.
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
    public void CoreSources_NameTheWholeModMixinOnlyInTheSeedFile()
    {
        const string mixinTypeName = "MutagenJsonConverterFallout4ModMixIns";
        const string expectedFile = "RecordTextCodecGeneratorSeed.cs";

        var sourceFiles = Directory.GetFiles(CoreSourceRoot(), "*.cs", SearchOption.AllDirectories);
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != expectedFile)
            .Where(f => File.ReadAllText(f).Contains(mixinTypeName, StringComparison.Ordinal))
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

        // #412: name confirmed empirically, not by naming-convention guesswork — a scratch project
        // seeded with MutagenJsonConverter.Instance.Serialize(mod, folder) and built with
        // -p:EmitCompilerGeneratedFiles=true actually emits this exact type, in this exact namespace.
        Assert.Equal(["Mutagen.Bethesda.Serialization.Newtonsoft.MutagenJsonConverterFallout4ModMixIns"], alienPublicTypes);
    }

    private static string CoreSourceRoot([CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "MEditService.Core"));
}
