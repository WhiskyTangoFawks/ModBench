using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// A structural write lands the child's file and the parent's ordered child list together, or lands
/// neither. Order is parent data (ADR-0042 decision 4), so those two writes are one edit split across
/// two files — and #677/#678 (ADR-0045) already established that an action of this shape commits once
/// or not at all.
///
/// <para><b>The two halves fail very differently, which is what makes this worth pinning.</b> The
/// drift rule is deliberately asymmetric: a listed child with no file is honoured as a deletion, but a
/// file no list names is refused outright and re-Track is the only recovery. So a create that writes
/// the file and then fails to write the list does not leave a cosmetic inconsistency — it leaves the
/// plugin unreadable. The delete path is safe for free (it removes the file first, so an interruption
/// lands on the tolerated side); the create and copy paths are the ones that need the guarantee.</para>
///
/// <para>The failure is injected by making the carrier path unwritable in the one way that needs no
/// permissions and works identically on every platform: a <i>directory</i> sits where the document
/// belongs, so writing it throws.</para>
/// </summary>
public sealed class StructuralWriteAtomicityTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService EditService() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private string NpcsDirectory =>
        Path.Combine(_mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");

    [Fact]
    public void CreateRecord_WhoseOrderedChildListCannotBeWritten_LeavesNoRecordFileBehind()
    {
        var carrier = SourceChildOrder.CarrierFor(NpcsDirectory, parentIsRecord: false);
        var recordFilesBefore = RecordFiles();

        // Make the carrier unwritable: a directory where the document should be.
        File.Delete(carrier);
        Directory.CreateDirectory(carrier);

        Assert.ThrowsAny<Exception>(() => EditService().CreateRecord(_mod.Plugin, "npc_", "Doomed"));

        // The whole point: no file for a record no list can name. Without the two writes being one
        // action, the record's file is sitting there unlisted, and the next read of this plugin
        // refuses the entire tree.
        Assert.Equal(recordFilesBefore, RecordFiles());
        Assert.DoesNotContain(RecordFiles(), name => name.Contains("Doomed", StringComparison.Ordinal));
    }

    /// <summary>The delete path's own half of the same guarantee — and the reason it needs no
    /// transaction: it removes the file before touching the list, so an interruption between them
    /// leaves a listed child with no file, which reads honour as the deletion the author asked
    /// for.</summary>
    [Fact]
    public void DeleteRecord_InterruptedAfterTheFileGoes_LeavesTheToleratedDirection_NotTheRefusedOne()
    {
        var carrier = SourceChildOrder.CarrierFor(NpcsDirectory, parentIsRecord: false);
        var listedBefore = SourceChildOrder.ListAt(carrier, "Npcs");
        Assert.Contains(_mod.Npc.ToString(), listedBefore, StringComparer.Ordinal);

        File.Delete(carrier);
        Directory.CreateDirectory(carrier);

        // Whether this throws or not, what matters is which side of the asymmetry the tree lands on.
        try { EditService().DeleteRecord(_mod.Plugin, _mod.Npc.ToString()); }
        catch (Exception) { /* the carrier write is what failed; the file removal is the point */ }

        // No file that no list names. The record's file is gone, which is the tolerated direction
        // however far the write got.
        Assert.DoesNotContain(
            RecordFiles(), name => name.Contains(TrackedModFixture.NpcEditorId, StringComparison.Ordinal));
    }

    private List<string> RecordFiles() =>
        [.. Directory.GetFiles(NpcsDirectory)
            .Select(Path.GetFileName)
            .Select(name => name!)
            .Where(name => !name.Equals("GroupRecordData.json", StringComparison.Ordinal))
            .Order(StringComparer.Ordinal)];
}
