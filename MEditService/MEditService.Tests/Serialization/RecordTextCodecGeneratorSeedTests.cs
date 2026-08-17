using System.Reflection;
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
    // ever grows a whole-mod-accepting method.
    [Fact]
    public void SerializationNamespace_ExposesNoPublicApiAcceptingAWholeModType()
    {
        var offendingMembers = typeof(RecordTextCodec).Assembly.GetTypes()
            .Where(t => t.IsPublic && t.Namespace == "MEditService.Core.Serialization")
            .SelectMany(t => t.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly))
            .Where(m => m.GetParameters().Any(p => typeof(IModGetter).IsAssignableFrom(p.ParameterType))
                || typeof(IModGetter).IsAssignableFrom(m.ReturnType))
            .Select(m => $"{m.DeclaringType!.FullName}.{m.Name}")
            .ToList();

        Assert.Empty(offendingMembers);
    }
}
