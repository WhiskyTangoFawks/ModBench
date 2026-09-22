using MEditService.Commands;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

// ADR-0013: the handler that turns a validated snapshot into Load order state's one arrival —
// what a reconcile does with that arrival is the Index's subscription, not this handler's.
public sealed class PutLoadOrderHandlerTests
{
    private const string DataFolder = "C:\\Data";
    private const string InstanceRoot = "C:\\Instance";

    private readonly LoadOrderHolder _holder = new();
    private readonly ForcingAdapter _adapter = new();

    private PutLoadOrderHandler Handler => TestEditService.PutLoadOrderHandler(_holder, _adapter);

    private static LoadOrderEntry Entry(string name, int slot) =>
        new(name, $"C:\\Instance\\mods\\ModA\\{name}", "ModA", slot, Enabled: true, Winning: true);

    private PutLoadOrderResult Put(GameRelease release = GameRelease.Fallout4, params LoadOrderEntry[] entries) =>
        Handler.Put(DataFolder, InstanceRoot, release, entries);

    [Fact]
    public void Put_WithASupportedRelease_AppliesTheSnapshotToLoadOrderState()
    {
        var result = Put(entries: Entry("A.esp", 0));

        Assert.True(result.Applied);
        Assert.Equal(DataFolder, _holder.Current.DataFolderPath);
        Assert.Equal(InstanceRoot, _holder.Current.InstanceRoot);
        Assert.Equal(GameRelease.Fallout4, _holder.Current.GameRelease);
        Assert.Equal(["A.esp"], _holder.Current.Copies.Select(c => c.Name));
        Assert.Equal(_holder.Version, result.Version);
    }

    // A release this build has no Mutagen assembly for is discovered here, synchronously, never
    // inside a reconcile the caller cannot see.
    [Fact]
    public void Put_UnsupportedGameRelease_RefusesWithoutApplying()
    {
        var result = Put(GameRelease.SkyrimSE, Entry("A.esp", 0));

        Assert.False(result.Applied);
        Assert.Equal(PutLoadOrderRefusal.UnsupportedGameRelease, result.Refusal);
        Assert.Contains("SkyrimSE", result.Message, StringComparison.Ordinal);
        Assert.Equal(LoadOrderSnapshot.Empty, _holder.Current);
    }

    // ADR-0013 invariant 2: the forced names are the one fact the service derives, so the snapshot
    // every subscriber sees is the one the game loads.
    [Fact]
    public void Put_PrependsTheForcedPlugins_AndOffsetsEverySentSlotByTheirCount()
    {
        _adapter.Forced = ["Fallout4.esm", "DLCRobot.esm"];

        var result = Put(entries: [Entry("A.esp", 0), Entry("B.esp", 1)]);

        Assert.True(result.Applied);
        Assert.Equal(
            [("Fallout4.esm", 0), ("DLCRobot.esm", 1), ("A.esp", 2), ("B.esp", 3)],
            _holder.Current.Copies.Select(c => (c.Name, c.Slot ?? -1)));
    }

    [Fact]
    public void Put_RegistersEachForcedPlugin_AsAWinningEnabledCopyOfTheDataDirectory()
    {
        _adapter.Forced = ["Fallout4.esm"];

        Put(entries: Entry("A.esp", 0));

        var forced = _holder.Current.Copies[0];
        Assert.True(forced.IsForced);
        Assert.True(forced.Enabled);
        Assert.True(forced.Winning);
        Assert.Equal(PluginOrigin.DataDirectory, forced.Origin);
        Assert.Equal(Path.Combine(DataFolder, "Fallout4.esm"), forced.Path);
        Assert.False(_holder.Current.Copies[1].IsForced);
    }

    // A sent entry naming a forced plugin would give one file two copies; the forced row is the
    // one the game loads, so it is the one kept.
    [Fact]
    public void Put_DropsASentEntry_ThatNamesAForcedPlugin()
    {
        _adapter.Forced = ["Fallout4.esm"];

        Put(entries: [Entry("fallout4.esm", 0), Entry("A.esp", 1)]);

        Assert.Equal(["Fallout4.esm", "A.esp"], _holder.Current.Copies.Select(c => c.Name));
        Assert.Equal([0, 2], _holder.Current.Copies.Select(c => c.Slot));
    }

    // An unlisted copy has no slot to offset: it stays unlisted.
    [Fact]
    public void Put_LeavesAnUnslottedEntryUnslotted_PastTheForcedPlugins()
    {
        _adapter.Forced = ["Fallout4.esm"];

        Put(entries: new LoadOrderEntry("Loose.esp", "C:\\Instance\\mods\\ModA\\Loose.esp", "ModA", null, false, false));

        Assert.Null(_holder.Current.Copies[1].Slot);
    }

    private sealed class ForcingAdapter : ReadOnlyPluginAdapter
    {
        public IReadOnlyList<string> Forced { get; set; } = [];

        public override IReadOnlyList<string> ImplicitPluginsIn(string dataFolder, GameRelease gameRelease) =>
            dataFolder == DataFolder ? Forced : throw new InvalidOperationException($"Asked for {dataFolder}.");
    }
}
