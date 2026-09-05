using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>Five of these six pass independently of the Apply delegate: FormLink validation and
/// <c>RefuseIfBlocked</c> run before <c>TryApply</c> checks for a null Apply.</summary>
public sealed class TopLevelFormLinkColumnEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // OtherNpc's own "Race" field is at the CLR default, so pointing it at _mod.Race is a real value
    // change, not a same-value no-op that could pass by producing byte-identical output.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_AcceptsAValidTarget_LandsAsWorkingTreeChange()
    {
        Assert.Empty(_mod.GitStatus());

        var result = Service().Set(_mod.Plugin, _mod.OtherNpc.ToString(), "Race", Json($"\"{_mod.Race}\""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());

        // Answers at Effective: the read model's own document for OtherNpc now carries the new race.
        var body = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.OtherNpc.ToString(), _mod.Plugin)!.Body!;
        Assert.Contains(_mod.Race.ToString(), body, StringComparison.Ordinal);
    }

    // ValidateFormLinks runs ahead of
    // the null-Apply ReadOnly check, so a dangling target on this column is never silently blocked
    // by read-onliness.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_RefusesADanglingTarget()
    {
        var result = Service().Set(_mod.Plugin, _mod.OtherNpc.ToString(), "Race", Json("\"ABCDEF:NoSuchPlugin.esp\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // Same reasoning: Keyword resolves
    // (it exists) but is the wrong type for a RACE-typed column, and that check does not consult Apply.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_RefusesTheWrongRecordType()
    {
        var result = Service().Set(_mod.Plugin, _mod.OtherNpc.ToString(), "Race", Json($"\"{_mod.Keyword}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // RefuseIfBlocked runs before any
    // column is even looked up, so this inherits unconditionally of Apply.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_Refuses_WhenPluginIsUntracked()
    {
        using var untracked = TrackedModFixture.Untracked();

        var result = new RecordEditService(untracked.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .Set(untracked.Plugin, untracked.OtherNpc.ToString(), "Race", Json($"\"{untracked.Race}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
    }

    // Same RefuseIfBlocked gate.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_Refuses_WhileExternalChangeDeferralIsUnanswered()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        var result = Service().Set(_mod.Plugin, _mod.OtherNpc.ToString(), "Race", Json($"\"{_mod.Race}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // The third RefuseIfBlocked
    // outcome (a vanilla/DLC master with no mod folder to Track at all), same unconditional-of-Apply
    // gate as the untracked and unanswered-deferral cases above.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_Refuses_WhenPluginHasNoModFolder()
    {
        using var vanilla = new DataDirectoryFixture();

        var result = new RecordEditService(vanilla.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .Set(vanilla.Plugin, vanilla.Npc.ToString(), "Race", Json($"\"{_mod.Race}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
    }

    // A Data-directory master has no mod folder, so RefuseIfBlocked answers PluginHasNoModFolder
    // rather than PluginNotTracked.
    private sealed class DataDirectoryFixture : IDisposable
    {
        private const string Name = "Vanilla.esm";

        public string GameDirectory { get; }
        public LoadOrderMirror Mirror { get; }
        public PluginKey Plugin { get; } = new(Name, PluginOrigin.DataDirectory);
        public FormKey Npc { get; }

        public DataDirectoryFixture()
        {
            GameDirectory = Directory.CreateTempSubdirectory("medit-429-vanilla-").FullName;
            var pluginPath = Path.Combine(GameDirectory, Name);
            var mod = new Fallout4Mod(ModKey.FromFileName(Name), Fallout4Release.Fallout4);
            Npc = mod.Npcs.AddNew("VanillaNpc").FormKey;
            mod.WriteToBinary(pluginPath);

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(
                GameDirectory,
                [new LoadOrderEntry(Name, pluginPath, PluginOrigin.DataDirectory, Slot: 0, Enabled: true, Winning: true)],
                GameRelease.Fallout4);
        }

        public void Dispose()
        {
            Mirror.Dispose();
            try { Directory.Delete(GameDirectory, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
        }
    }
}
