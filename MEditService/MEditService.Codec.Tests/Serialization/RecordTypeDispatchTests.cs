using MEditService.Codec.Serialization;
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
    public void RoundTrip_DispatchesNpcByRuntimeType_OneOfTwoDifferentlyShapedGeneratedClassesSoResolvesForTheOneTypeTriedIsToldApartFromResolvesByAHoldingNamingConvention()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeNpc();

        IMajorRecordGetter callerNeverNamesTheConcreteTypeToSerializeOnlyToDeserializeBackIntoOne = original;
        var text = codec.SerializeToText(callerNeverNamesTheConcreteTypeToSerializeOnlyToDeserializeBackIntoOne, GameRelease.Fallout4);

        Assert.Contains("\"Test NPC Name\"", text, StringComparison.Ordinal);
        Assert.Equal(text, codec.RoundTrip(text, GameRelease.Fallout4, "npc_"));
    }

    [Fact]
    public void RoundTrip_DispatchesCellByRuntimeType()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeCell();

        var text = codec.SerializeToText(original, GameRelease.Fallout4);

        Assert.Contains("\"TestCell\"", text, StringComparison.Ordinal);
        Assert.Equal(text, codec.RoundTrip(text, GameRelease.Fallout4, "Cell"));
    }

    [Fact]
    public void RoundTrip_ForTextNamingAnUnknownType_ThrowsNotSupportedNamingTheMember_NotABareNullReferenceExceptionBecauseARecordTypeTheSchemaDoesNotKnowMeansExpectTheDocumentToNameItself()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var globalFloatNotAnNpcBecauseOnlyPathAmbiguousTypesSelfDescribeSoAnNpcDocumentHasNoDiscriminatorToCorrupt = MakeGlobalFloat();
        var text = codec.SerializeToText(globalFloatNotAnNpcBecauseOnlyPathAmbiguousTypesSelfDescribeSoAnNpcDocumentHasNoDiscriminatorToCorrupt, GameRelease.Fallout4);

        Assert.Contains("\"MutagenObjectType\": \"GlobalFloat\"", text, StringComparison.Ordinal);
        var corrupted =
            text.Replace("\"MutagenObjectType\": \"GlobalFloat\"", "\"MutagenObjectType\": \"NotARecordType\"", StringComparison.Ordinal);

        var ex = Assert.Throws<NotSupportedException>(
            () => codec.RoundTrip(corrupted, GameRelease.Fallout4, "glob"));

        const string TheMemberNameNotTheOffendingValueBecauseTheKernelDiscardsItOnThisRouteSoRequiringItWouldPinAnUpstreamDetail = "MutagenObjectType";
        Assert.Contains(TheMemberNameNotTheOffendingValueBecauseTheKernelDiscardsItOnThisRouteSoRequiringItWouldPinAnUpstreamDetail, ex.Message, StringComparison.Ordinal);
    }
}
