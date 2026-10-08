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
    public async Task AnNpc_ReadsBackFieldFaithful()
    {
        var original = MakeNpc();
        var mod = new Fallout4Mod(original.FormKey.ModKey, Fallout4Release.Fallout4);
        mod.Npcs.Add(original);

        AssertFieldFaithful(MaskInspector.CountLeaves(original.GetEqualsMask(await ReadBack.ThroughTheWholeModDoor<INpcGetter>(mod, original))));
    }

    [Fact]
    public async Task ACell_ReadsBackFieldFaithful()
    {
        var original = MakeCell();
        var mod = new Fallout4Mod(original.FormKey.ModKey, Fallout4Release.Fallout4);
        var subBlock = new CellSubBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellSubBlock };
        subBlock.Cells.Add(original);
        var block = new CellBlock { BlockNumber = 0, GroupType = GroupTypeEnum.InteriorCellBlock };
        block.SubBlocks.Add(subBlock);
        mod.Cells.Records.Add(block);

        AssertFieldFaithful(MaskInspector.CountLeaves(original.GetEqualsMask(await ReadBack.ThroughTheWholeModDoor<ICellGetter>(mod, original))));
    }

    private static void AssertFieldFaithful(IEnumerable<(string Path, bool Value)> leaves)
    {
        var all = leaves.ToList();
        Assert.NotEmpty(all);
        Assert.Empty(all.Where(l => !l.Value).Select(l => l.Path));
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
