using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

public sealed class WorkingTreeChangeMarkingTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginAddress _baseKey;
    private readonly PluginAddress _winnerKey;
    private readonly string _keptNpc;
    private readonly string _soleSourcedNpcWhoseOneEntryIsItsOwnWinner;

    public WorkingTreeChangeMarkingTests()
    {
        FormKey keptFk = default, droppedFk = default;
        _fixture = new PluginFixtureBuilder("recordref-identity")
            .WithPlugin("Base.esm", mod =>
            {
                keptFk = mod.Npcs.AddNew("KeepMe").FormKey;
                droppedFk = mod.Npcs.AddNew("DropMe").FormKey;
            }, origin: "BaseMod")
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == keptFk).DeepCopy());
            }, origin: "WinnerMod")
            .BuildScattered()
            .Tracked();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _baseKey = _base.KeyOf();
        _winnerKey = _fixture.Plugins.Single(p => p.Name == "Winner.esp").KeyOf();
        _keptNpc = keptFk.ToString();
        _soleSourcedNpcWhoseOneEntryIsItsOwnWinner = droppedFk.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void AWorkingTreeChange_MarksOnlyTheEditedRecord()
    {
        using var index = Indexes.Reconciled(_fixture);
        var reads = index.RequireReads();
        var before = reads.DocumentOf(_keptNpc, _baseKey);
        index.Edit(_base, before, before.BodyOf().Replace("KeepMe", "RenamedInWorkingTree", StringComparison.Ordinal));

        var stack = reads.GetOverrideStack(_keptNpc);
        Assert.NotNull(stack);
        var baseEntry = stack.Entries.Single(e => e.Plugin.Equals(_baseKey));
        Assert.True(baseEntry.HasWorkingTreeChange);

        var winnerEntry = stack.Entries.Single(e => e.Plugin.Equals(_winnerKey));
        Assert.False(winnerEntry.HasWorkingTreeChange);

        var untouched = reads.StackEntry(_soleSourcedNpcWhoseOneEntryIsItsOwnWinner, _baseKey);
        Assert.NotNull(untouched);
        Assert.False(untouched.HasWorkingTreeChange);
    }
}
