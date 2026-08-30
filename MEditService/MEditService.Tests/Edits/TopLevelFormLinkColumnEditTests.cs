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
/// #429: a top-level scalar FormLink <b>column</b> (e.g. an NPC's Race) gets a write path through
/// the same single door as every other FormLink shape (ADR-0034 — xEdit edits any FormID field in
/// place). Before this ticket <c>SchemaReflector</c> gave a bare FormLink column a null <c>Apply</c>
/// ("read-only as a column, <c>ApplyFormLinkJson</c> as a sub-field"), so <c>RecordFieldWriter</c>
/// answered <see cref="RecordEditRefusal.FieldReadOnly"/> for it regardless of the value's validity.
///
/// <para><b>Green-on-arrival, by design, for five of these six.</b> <c>RecordEditService.EditField</c>
/// validates a FormLink column's incoming value (<c>ValidateFormLinks</c> → <c>CheckErrorBuilder</c>)
/// <i>before</i> it ever reaches <c>RecordFieldWriter.TryApply</c>'s null-<c>Apply</c> check, and that
/// validation reads the column's schema metadata (<c>ApiType</c>/<c>ValidFormKeyTypes</c>), which was
/// always populated for a FormLink column independent of whether <c>Apply</c> was null. The untracked,
/// no-mod-folder and external-change-deferral refusals are checked earlier still, in
/// <c>RefuseIfBlocked</c>, ahead of any column lookup at all. So five of the six tests below already
/// passed against the code as it stood before this ticket's <c>SchemaReflector</c> fix — confirmed by
/// running them against that code, not assumed — and are kept here anyway because the acceptance
/// criteria ask for this exact column class to carry its own end-to-end proof, not a citation to
/// generic coverage that happens to use a different field. Only
/// <see cref="EditField_TopLevelFormLinkColumn_AcceptsAValidTarget_LandsAsWorkingTreeChange"/> is a
/// genuine red-to-green slice of this ticket's diff.
/// </summary>
public sealed class TopLevelFormLinkColumnEditTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // Genuine red-before/green-after slice of this ticket: OtherNpc's own "race" field is the CLR
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

    // Pre-fix observed result: InvalidFormLink (already refused) — ValidateFormLinks runs ahead of
    // the null-Apply ReadOnly check, so a dangling target on this column was never silently blocked
    // by read-onliness in the first place.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_RefusesADanglingTarget()
    {
        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json("\"ABCDEF:NoSuchPlugin.esp\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // Pre-fix observed result: InvalidFormLink (already refused) — same reasoning: Keyword resolves
    // (it exists) but is the wrong type for a RACE-typed column, and that check does not consult Apply.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_RefusesTheWrongRecordType()
    {
        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json($"\"{_mod.Keyword}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // Pre-fix observed result: PluginNotTracked (already refused) — RefuseIfBlocked runs before any
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

    // Pre-fix observed result: ExternalChangeUnanswered (already refused) — same RefuseIfBlocked gate,
    // #417 exit path 3.
    [Fact]
    public void EditField_TopLevelFormLinkColumn_Refuses_WhileExternalChangeDeferralIsUnanswered()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        var result = Service().EditField(_mod.Plugin, _mod.OtherNpc.ToString(), "race", Json($"\"{_mod.Race}\""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // Pre-fix observed result: PluginHasNoModFolder (already refused) — the third RefuseIfBlocked
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
