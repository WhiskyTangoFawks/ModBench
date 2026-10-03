using MEditService.Codec.Serialization;
using MEditService.Codec.Tests.TestSupport;
using MEditService.TestSupport;
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
    public async Task SerializeAsync_ThenDeserializeFile_DispatchesNpcByRuntimeType_OneOfTwoDifferentlyShapedGeneratedClassesSoResolvesForTheOneTypeTriedIsToldApartFromResolvesByAHoldingNamingConvention()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeNpc();
        using var dir = new ScratchDirectory("medit-dispatch-npc-");
        var filePath = Path.Combine(dir.Path, "npc.json");

        IMajorRecordGetter callerNeverNamesTheConcreteTypeToSerializeOnlyToDeserializeBackIntoOne = original;
        await codec.SerializeAsync(callerNeverNamesTheConcreteTypeToSerializeOnlyToDeserializeBackIntoOne, filePath, GameRelease.Fallout4);
        var roundTripped = (Npc)codec.DeserializeFile(filePath, GameRelease.Fallout4, "npc_");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.NotEmpty(leaves);
        Assert.Empty(divergent);
    }

    [Fact]
    public async Task SerializeAsync_ThenDeserializeFile_DispatchesCellByRuntimeType_AChildlessCellSoItAlreadyEmitsOneFileWithNoShallowCopyInterventionWhileContainerSingleFileTestsCoversTheLayoutOncePopulated()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var original = MakeCell();
        using var dir = new ScratchDirectory("medit-dispatch-cell-");
        var filePath = Path.Combine(dir.Path, "cell.json");

        await codec.SerializeAsync(original, filePath, GameRelease.Fallout4);
        var roundTripped = (Cell)codec.DeserializeFile(filePath, GameRelease.Fallout4, "Cell");

        var mask = original.GetEqualsMask(roundTripped);
        var leaves = MaskInspector.CountLeaves(mask).ToList();
        var divergent = leaves.Where(l => !l.Value).Select(l => l.Path).ToList();

        Assert.NotEmpty(leaves);
        Assert.Empty(divergent);
        Assert.Equal([filePath], Directory.GetFiles(dir.Path, "*", SearchOption.AllDirectories));
    }

    [Fact]
    public async Task DeserializeFile_ForTextNamingAnUnknownType_ThrowsNamedException_NotABareNullReferenceExceptionBecauseARecordTypeTheSchemaDoesNotKnowMeansExpectTheDocumentToNameItself()
    {
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        using var dir = new ScratchDirectory("medit-dispatch-unsupported-");
        var filePath = Path.Combine(dir.Path, "unsupported.json");
        var globalFloatNotAnNpcBecauseOnlyPathAmbiguousTypesSelfDescribeSoAnNpcDocumentHasNoDiscriminatorToCorrupt = MakeGlobalFloat();
        await codec.SerializeAsync(globalFloatNotAnNpcBecauseOnlyPathAmbiguousTypesSelfDescribeSoAnNpcDocumentHasNoDiscriminatorToCorrupt, filePath, GameRelease.Fallout4);

        var text = await File.ReadAllTextAsync(filePath);
        Assert.Contains("\"MutagenObjectType\": \"GlobalFloat\"", text, StringComparison.Ordinal);
        await File.WriteAllTextAsync(filePath,
            text.Replace("\"MutagenObjectType\": \"GlobalFloat\"", "\"MutagenObjectType\": \"NotARecordType\"", StringComparison.Ordinal));

        var ex = Assert.Throws<RecordTypeSerializationUnsupportedException>(
            () => codec.DeserializeFile(filePath, GameRelease.Fallout4, "glob"));

        const string TheMemberNameNotTheOffendingValueBecauseTheKernelDiscardsItOnThisRouteSoRequiringItWouldPinAnUpstreamDetail = "MutagenObjectType";
        Assert.Contains(TheMemberNameNotTheOffendingValueBecauseTheKernelDiscardsItOnThisRouteSoRequiringItWouldPinAnUpstreamDetail, ex.Message, StringComparison.Ordinal);
    }
}
