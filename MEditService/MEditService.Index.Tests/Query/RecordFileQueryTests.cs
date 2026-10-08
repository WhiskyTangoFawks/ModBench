using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

public sealed class RecordFileQueryTests : IDisposable
{
    private const string Npc = "000800:Filed.esp";
    private static readonly PluginAddress Plugin = new("Filed.esp", "FiledMod");

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("record-file-query")
        .WithPlugin(Plugin.Name, mod => mod.Npcs.AddNew("FiledNpc"), origin: Plugin.Origin)
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Entry => _fixture.Plugins.Single();

    private string NpcFile =>
        Path.Combine(PluginSourceRoot.In(Entry.ModFolderOf(), Plugin.Name), "Npcs", "FiledNpc - 000800_Filed.esp.json");

    private OpenedIndex Reconciled() => Indexes.Reconciled(_fixture);

    [Fact]
    public void ATrackedCopy_IsInItsFile()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Reconciled();

        Assert.Equal(new RecordFile(NpcFile), index.Records.GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void ATrackedCopyInAPluginThatIsNotActive_IsInItsFile()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Indexes.Reconciled(_fixture.GameDirectory, [Entry with { Enabled = false }]);

        Assert.Equal(new RecordFile(NpcFile), index.Records.GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void ATrackedCopyWhoseFileIsGone_HasNoAnswer()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        using var index = Reconciled();

        File.Delete(NpcFile);

        Assert.Null(index.Records.GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void AnUntrackedCopy_IsInNoFile()
    {
        using var index = Reconciled();

        Assert.Equal(new RecordFile(null), index.Records.GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void ACopyInATrackedModWithNoSourceForItsPlugin_IsInNoFile()
    {
        TrackedMods.Track(Entry, _fixture.GameDirectory);
        Directory.Delete(PluginSourceRoot.In(Entry.ModFolderOf(), Plugin.Name), recursive: true);
        using var index = Reconciled();

        Assert.Equal(new RecordFile(null), index.Records.GetRecordFile(Plugin, Npc));
    }

    [Fact]
    public void ACopyThePluginDoesNotHold_HasNoAnswer()
    {
        using var index = Reconciled();

        Assert.Null(index.Records.GetRecordFile(Plugin with { Origin = "AnotherMod" }, Npc));
    }
}
