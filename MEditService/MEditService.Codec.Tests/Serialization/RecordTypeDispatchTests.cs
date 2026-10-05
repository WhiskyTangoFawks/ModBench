using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Tests.Serialization;

public class RecordTypeDispatchTests
{
    private static Npc MakeNpc() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x900), Fallout4Release.Fallout4)
        {
            EditorID = "TestNpc",
            Name = "Test NPC Name",
        };

    private static GlobalFloat MakeGlobalFloat() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x902), Fallout4Release.Fallout4)
        {
            EditorID = "TestGlobal",
            Data = 1.5f,
        };

    private static Cell MakeCell() =>
        new(new FormKey(ModKey.FromFileName("Test.esp"), 0x901), Fallout4Release.Fallout4)
        {
            EditorID = "TestCell",
        };

    [Fact]
    public void SerializeToBytes_ThenDeserializeFromBytes_DispatchesNpcByRuntimeType_OneOfTwoDifferentlyShapedGeneratedClassesSoResolvesForTheOneTypeTriedIsToldApartFromResolvesByAHoldingNamingConvention()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeNpc();

        IMajorRecordGetter callerNeverNamesTheConcreteTypeToSerializeOnlyToDeserializeBackIntoOne = original;
        var bytes = codec.SerializeToBytes(callerNeverNamesTheConcreteTypeToSerializeOnlyToDeserializeBackIntoOne, GameRelease.Fallout4);
        var roundTripped = (Npc)codec.DeserializeFromBytes(bytes, GameRelease.Fallout4, "npc_");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.NotEmpty(leaves);
        Assert.Empty(divergent);
    }

    [Fact]
    public void SerializeToBytes_ThenDeserializeFromBytes_DispatchesCellByRuntimeType()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeCell();

        var bytes = codec.SerializeToBytes(original, GameRelease.Fallout4);
        var roundTripped = (Cell)codec.DeserializeFromBytes(bytes, GameRelease.Fallout4, "Cell");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.NotEmpty(leaves);
        Assert.Empty(divergent);
    }

    [Fact]
    public void DeserializeFromBytes_ForTextNamingAnUnknownType_ThrowsNamedException_NotABareNullReferenceExceptionBecauseARecordTypeTheSchemaDoesNotKnowMeansExpectTheDocumentToNameItself()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var globalFloatNotAnNpcBecauseOnlyPathAmbiguousTypesSelfDescribeSoAnNpcDocumentHasNoDiscriminatorToCorrupt = MakeGlobalFloat();
        var text = Encoding.UTF8.GetString(codec.SerializeToBytes(globalFloatNotAnNpcBecauseOnlyPathAmbiguousTypesSelfDescribeSoAnNpcDocumentHasNoDiscriminatorToCorrupt, GameRelease.Fallout4));

        Assert.Contains("\"MutagenObjectType\": \"GlobalFloat\"", text, StringComparison.Ordinal);
        var corrupted = Encoding.UTF8.GetBytes(
            text.Replace("\"MutagenObjectType\": \"GlobalFloat\"", "\"MutagenObjectType\": \"NotARecordType\"", StringComparison.Ordinal));

        var ex = Assert.Throws<RecordTypeSerializationUnsupportedException>(
            () => codec.DeserializeFromBytes(corrupted, GameRelease.Fallout4, "glob"));

        const string TheMemberNameNotTheOffendingValueBecauseTheKernelDiscardsItOnThisRouteSoRequiringItWouldPinAnUpstreamDetail = "MutagenObjectType";
        Assert.Contains(TheMemberNameNotTheOffendingValueBecauseTheKernelDiscardsItOnThisRouteSoRequiringItWouldPinAnUpstreamDetail, ex.Message, StringComparison.Ordinal);
    }
}
