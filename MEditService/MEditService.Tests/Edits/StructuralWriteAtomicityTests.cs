using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>No transaction here; that is the renumber cascade's tool (ADR-0045).</summary>
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

        // The whole point: no file for a record no list can name. Left behind, the record's file is
        // sitting there unlisted, and the next read of this plugin refuses the entire tree.
        Assert.Equal(recordFilesBefore, RecordFiles());
        Assert.DoesNotContain(RecordFiles(), name => name.Contains("Doomed", StringComparison.Ordinal));
    }

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
