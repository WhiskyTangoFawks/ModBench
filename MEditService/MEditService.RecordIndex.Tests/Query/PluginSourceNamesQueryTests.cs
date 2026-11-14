using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class PluginSourceNamesQueryTests : IDisposable
{
    private static readonly PluginAddress Plugin = new("Filed.esp", "FiledMod");

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("plugin-source-names-query")
        .WithPlugin(Plugin.Name, mod =>
        {
            var npc = mod.Npcs.AddNew("FiledNpc");
            npc.VirtualMachineAdapter = new VirtualMachineAdapter();
            npc.VirtualMachineAdapter.Scripts.Add(new ScriptEntry { Name = "Attached" });
        }, origin: Plugin.Origin)
        .BuildScattered();

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Entry => _fixture.Plugins.Single();

    private string NpcFile => Directory.EnumerateFiles(
        PluginSourceRoot.In(Entry.ModFolderOf(), Plugin.Name), "FiledNpc - *.json", SearchOption.AllDirectories).Single();

    private static string[] ScriptsIn(IReadOnlyList<DocumentName> names) =>
        [.. names.Where(name => name.Kind == DocumentNameKind.Script).Select(name => name.Value)];

    [Fact]
    public void APluginSourceFile_NamesWhatItsRecordsTypeSays_InTheTextHandedIn()
    {
        SourceMods.Init(Entry);
        using var index = Indexes.Reconciled(_fixture);
        var unsaved = File.ReadAllText(NpcFile).Replace("\"Attached\"", "\"Typed\"", StringComparison.Ordinal);

        Assert.Equal(["Typed"], ScriptsIn(index.Queries.GetPluginSourceNames(NpcFile, unsaved, null).Value()));
    }

    [Fact]
    public void AFileNoPluginsSourceHolds_HoldsNoName()
    {
        SourceMods.Init(Entry);
        using var index = Indexes.Reconciled(_fixture);
        var loose = Path.Combine(Entry.ModFolderOf(), "Loose.json");

        Assert.Empty(index.Queries.GetPluginSourceNames(loose, File.ReadAllText(NpcFile), null).Value());
    }

    [Fact]
    public void AFile_WithNoLoadOrder_IsRefused_ForNoPluginSourceCanBeSaidToHoldIt()
    {
        using var index = Indexes.Open(new LoadOrderHolder());

        var refused = index.Queries.GetPluginSourceNames(Path.GetFullPath("Loose.json"), "{}", null).Refused();

        Assert.Equal(IndexRefusal.NoLoadOrder, refused.Refusal);
    }

    [Fact]
    public void ATextWithNoFile_IsReadAsARecordsDocument()
    {
        SourceMods.Init(Entry);
        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal(["Attached"], ScriptsIn(index.Queries.GetPluginSourceNames(null, File.ReadAllText(NpcFile), null).Value()));
    }
}
