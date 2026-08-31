using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// A top-level scalar FormLink <b>column</b> (e.g. an NPC's Race) gets a write path through
/// the same single door as every other FormLink shape (ADR-0034 — xEdit edits any FormID field in
/// place). A <c>SchemaReflector</c> that gave a bare FormLink column a null <c>Apply</c>
/// ("read-only as a column, <c>ApplyFormLinkJson</c> as a sub-field") made <c>RecordFieldWriter</c>
/// answer <see cref="RecordEditRefusal.FieldReadOnly"/> for it regardless of the value's validity.
///
/// <para><b>Five of these six pass independently of the Apply delegate, by design.</b> <c>RecordEditService.EditField</c>
/// validates a FormLink column's incoming value (<c>ValidateFormLinks</c> → <c>CheckErrorBuilder</c>)
/// <i>before</i> it ever reaches <c>RecordFieldWriter.TryApply</c>'s null-<c>Apply</c> check, and that
/// validation reads the column's schema metadata (<c>ApiType</c>/<c>ValidFormKeyTypes</c>), which is
/// populated for a FormLink column independent of whether <c>Apply</c> is null. The untracked,
/// no-mod-folder and external-change-deferral refusals are checked earlier still, in
/// <c>RefuseIfBlocked</c>, ahead of any column lookup at all. They are kept here anyway
/// because this exact column class should carry its own end-to-end proof, not a citation to
/// generic coverage that happens to use a different field. Only
/// <see cref="EditField_TopLevelFormLinkColumn_AcceptsAValidTarget_LandsAsWorkingTreeChange"/>
/// exercises the write delegate itself.
/// </summary>
public sealed class TopLevelFormLinkColumnEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // The write delegate itself: OtherNpc's own "race" field is the CLR
    // default (never set by TrackedModFixture), so pointing it at _mod.Race is a real value change,
    // not a same-value no-op that could pass by producing byte-identical output.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_AcceptsAValidTarget_LandsAsWorkingTreeChange()
    {
        Assert.Empty(_mod.GitStatus());

        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json($"\"{_mod.Race}\""));

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());

        // Answers at Effective: the read model's own document for OtherNpc now carries the new race.
        var body = _mod.Mirror.Index!.GetDocument(_mod.OtherNpc.ToString(), _mod.Plugin)!.Body!;
        Assert.Contains(_mod.Race.ToString(), body, StringComparison.Ordinal);
    }

    // ValidateFormLinks runs ahead of
    // the null-Apply ReadOnly check, so a dangling target on this column is never silently blocked
    // by read-onliness.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_RefusesADanglingTarget()
    {
        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json("\"ABCDEF:NoSuchPlugin.esp\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // Same reasoning: Keyword resolves
    // (it exists) but is the wrong type for a RACE-typed column, and that check does not consult Apply.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_RefusesTheWrongRecordType()
    {
        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json($"\"{_mod.Keyword}\""));

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
            .EditField(untracked.Plugin, untracked.OtherNpc.ToString(), "race", Json($"\"{untracked.Race}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
    }

    // Same RefuseIfBlocked gate.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_Refuses_WhileExternalChangeDeferralIsUnanswered()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json($"\"{_mod.Race}\""));

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
            .EditField(vanilla.Plugin, vanilla.Npc.ToString(), "race", Json($"\"{_mod.Race}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginHasNoModFolder, result.Refusal);
    }

    /// <summary>A vanilla/DLC master resolved straight from the game's Data directory — no mod
    /// folder, so <c>RefuseIfBlocked</c> answers <see cref="RecordEditRefusal.PluginHasNoModFolder"/>
    /// rather than <see cref="RecordEditRefusal.PluginNotTracked"/> (<c>UntrackedReadOnlyTests</c>'
    /// own <c>DataDirectoryFixture</c>, duplicated here per this file's established
    /// self-contained-fixture pattern rather than shared, matching
    /// <c>GenericFieldWriteDispatchTests.ConditionOwnerFixture</c>).</summary>
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
