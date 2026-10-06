using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Queries.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

public sealed class RecordFileQueryTests : IDisposable
{
    private const string Npc = "000800:Filed.esp";
    private static readonly PluginAddress Plugin = new("Filed.esp", "FiledMod");

    private readonly ScratchDirectory _modFolder = new("medit-record-file-query-");

    public void Dispose() => _modFolder.Dispose();

    private RecordQueryService Service() =>
        new(
            new FakeIndex(new FakeReads(
                new Dictionary<PluginAddress, PluginContent>(),
                [new FakeRow(Plugin, 0, IsWinner: true, new RecordDocument(Npc, Plugin, 0, IsWinner: true, "FiledNpc", "npc_", "{}", []))])),
            FakeLoadOrder.Of(
                GameRelease.Fallout4,
                new LoadOrderEntry(Plugin.Name, Path.Combine(_modFolder, Plugin.Name), Plugin.Origin, Slot: 0, Enabled: true, Winning: true)),
            SharedSchemaReflector.Instance);

    [Fact]
    public void AnUntrackedCopy_IsInNoFile()
    {
        Assert.Equal(new RecordFile(null), Service().GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void ACopyInATrackedModWithNoSourceForItsPlugin_IsInNoFile()
    {
        SourceRepository.Track(_modFolder, [(
            [new TreeFile(Path.Combine(PluginSourceRoot.For("Other.esp"), "000000_Other.esp.json"), "{}"u8.ToArray())],
            new DecompiledPlugin("Other.esp", null))]);

        Assert.Equal(new RecordFile(null), Service().GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void ACopyThePluginDoesNotHold_HasNoAnswer()
    {
        Assert.Null(Service().GetRecordFile(Plugin with { Origin = "AnotherMod" }, Npc));
    }
}
