using MEditService.Core.Edits;
using MEditService.Core.Ledger;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #427: renumber, the delete+create pair plus cross-plugin reference cascade. Two-mod fixture
/// because the interesting question — does a renumber rewrite a FormLink living in a <i>different</i>
/// mod folder's own repo — cannot be asked of one.
/// </summary>
public sealed class RecordEditServiceRenumberRecordTests
{
    private static RecordEditService ServiceFor(ISessionManager sessions) =>
        new(sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void RenumberRecord_MovesToNewFormKey_OldGoneAtEffective_StillAtHead_NewAbsentAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Sessions).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        var index = mod.Sessions.Index!;
        Assert.Null(index.GetDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.NotNull(index.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.NotNull(index.GetDocument(result.NewFormKey!, mod.Plugin));
        Assert.Null(index.At(RecordRef.Head).GetDocument(result.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void RenumberRecord_WithARequestedTarget_UsesItExactly()
    {
        using var mod = TrackedModFixture.Tracked();
        const string requested = "900000:Fixture.esp";

        var result = ServiceFor(mod.Sessions).RenumberRecord(mod.Plugin, mod.Npc.ToString(), requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenTheRequestedTargetBelongsToADifferentPlugin()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Sessions)
            .RenumberRecord(mod.Plugin, mod.Npc.ToString(), "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void RenumberRecord_Refuses_OnAnOverrideRecord_NamingTheOriginatingPlugin()
    {
        using var two = TwoModFixture.Create(trackReferencer: true);

        // Npc, native to Base.esm, overridden (unedited copy) in Winner.esp — renumbering it from
        // Winner.esp's side is exactly the override case this gesture refuses.
        var result = ServiceFor(two.Sessions).RenumberRecord(two.WinnerPlugin, two.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
        Assert.Contains("Base.esm", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_RewritesATrackedReferencersFormLink_ToTheNewFormKey()
    {
        using var two = TwoModFixture.Create(trackReferencer: true);

        var result = ServiceFor(two.Sessions).RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.True(result.Applied, result.Message);
        var index = two.Sessions.Index!;
        var referencer = index.GetDocument(two.ReferencerNpc.ToString(), two.ReferencerPlugin)!;
        Assert.Contains(result.NewFormKey!, referencer.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(two.TargetRace.ToString(), referencer.Body, StringComparison.Ordinal);
        Assert.Contains(index.GetReferencedBy(result.NewFormKey!), r => r.FormKey == two.ReferencerNpc.ToString());
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencerIsUntracked_NamingIt_AndWritesNothing()
    {
        using var two = TwoModFixture.Create(trackReferencer: false);
        var oldRaceLedgerFile = two.LedgerFileFor(two.TargetPlugin, two.TargetRace, "race");

        var result = ServiceFor(two.Sessions).RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UntrackedReferencer, result.Refusal);
        Assert.Contains(TwoModFixture.ReferencerPluginName, result.Message, StringComparison.Ordinal);

        // Q5(a)/AC "no half-applied state": refused before any write, on either side of the cascade.
        Assert.True(File.Exists(oldRaceLedgerFile));
        Assert.NotNull(two.Sessions.Index!.GetDocument(two.TargetRace.ToString(), two.TargetPlugin));
        var referencerBody = two.Sessions.Index!.GetDocument(two.ReferencerNpc.ToString(), two.ReferencerPlugin)!.Body!;
        Assert.Contains(two.TargetRace.ToString(), referencerBody, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();

        var result = ServiceFor(mod.Sessions).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhileAnExternalChangeQuestionIsPending()
    {
        using var mod = TrackedModFixture.Tracked();
        ExternalChangeDeferral.Set(mod.ModFolder, TrackedModFixture.PluginName, "pending");

        var result = ServiceFor(mod.Sessions).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangePending, result.Refusal);
    }

    [Fact]
    public void PeekNextFreeFormKey_MatchesWhatRenumberWouldActuallyAllocate()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Sessions);

        var suggested = service.PeekNextFreeFormKey(mod.Plugin);
        var result = service.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.NotNull(suggested);
        Assert.Equal(suggested, result.NewFormKey);
    }

    /// <summary>
    /// Base.esm holds a native Race (the renumber target) and Winner.esp both overrides an unrelated
    /// Npc (giving the override-refusal test something to point at) and holds its own native Npc
    /// referencing Base.esm's Race — the cross-repo referencer <see cref="TwoModFixture.Sessions"/>
    /// loads both plugins into.
    /// </summary>
    private sealed class TwoModFixture : IDisposable
    {
        public const string ReferencerPluginName = "Winner.esp";
        private const string TargetPluginName = "Base.esm";
        private const string TargetOrigin = "TargetMod";
        private const string ReferencerOrigin = "ReferencerMod";

        public string TargetModFolder { get; }
        public string ReferencerModFolder { get; }
        public string GameDirectory { get; }
        public SessionManager Sessions { get; }
        public PluginKey TargetPlugin { get; } = new(TargetPluginName, TargetOrigin);
        public PluginKey WinnerPlugin { get; } = new(ReferencerPluginName, ReferencerOrigin);
        public PluginKey ReferencerPlugin => WinnerPlugin;
        public FormKey TargetRace { get; }
        public FormKey Npc { get; }
        public FormKey ReferencerNpc { get; }

        private TwoModFixture(bool trackReferencer)
        {
            TargetModFolder = Directory.CreateTempSubdirectory("medit-renumber-target-").FullName;
            ReferencerModFolder = Directory.CreateTempSubdirectory("medit-renumber-ref-").FullName;
            GameDirectory = Directory.CreateTempSubdirectory("medit-renumber-game-").FullName;

            var targetPath = Path.Combine(TargetModFolder, TargetPluginName);
            var targetMod = new Fallout4Mod(ModKey.FromFileName(TargetPluginName), Fallout4Release.Fallout4);
            var race = targetMod.Races.AddNew("TargetRace");
            var npc = targetMod.Npcs.AddNew("BaseNpc");
            targetMod.WriteToBinary(targetPath);
            (TargetRace, Npc) = (race.FormKey, npc.FormKey);

            var referencerPath = Path.Combine(ReferencerModFolder, ReferencerPluginName);
            var referencerMod = new Fallout4Mod(ModKey.FromFileName(ReferencerPluginName), Fallout4Release.Fallout4);
            referencerMod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetPluginName) });
            referencerMod.Npcs.Set(targetMod.Npcs.First(n => n.FormKey == npc.FormKey).DeepCopy()); // override, for the NotNativeRecord test
            var referencerNpc = referencerMod.Npcs.AddNew("ReferencerNpc");
            referencerNpc.Race.SetTo(race);
            referencerMod.WriteToBinary(referencerPath);
            ReferencerNpc = referencerNpc.FormKey;

            Sessions = new SessionManager(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ISessionManager)Sessions).LoadExplicit(
                GameDirectory,
                [
                    new ExplicitPluginInput(TargetPluginName, targetPath, TargetOrigin, true),
                    new ExplicitPluginInput(ReferencerPluginName, referencerPath, ReferencerOrigin, true),
                ],
                GameRelease.Fallout4);

            new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance)
                .TrackAsync(Sessions.Session!, TargetOrigin, LedgerPreset.Edits).GetAwaiter().GetResult();
            if (trackReferencer)
            {
                new TrackService(SharedSchemaReflector.Instance, NullLogger<TrackService>.Instance)
                    .TrackAsync(Sessions.Session!, ReferencerOrigin, LedgerPreset.Edits).GetAwaiter().GetResult();
            }
        }

        public static TwoModFixture Create(bool trackReferencer) => new(trackReferencer);

        public string LedgerFileFor(PluginKey plugin, FormKey formKey, string recordType) =>
            Path.Combine(plugin.Origin == TargetOrigin ? TargetModFolder : ReferencerModFolder,
                LedgerRecordPath.For(plugin.Name, recordType, formKey.ToString()));

        public void Dispose()
        {
            Sessions.Dispose();
            TryDelete(TargetModFolder);
            TryDelete(ReferencerModFolder);
            TryDelete(GameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
