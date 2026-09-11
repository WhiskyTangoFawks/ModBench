using System.Text;
using MEditService.Core.Notifications;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>ADR-0014: the Index's one projection verb, exercised directly through the seam rather
/// than through the Source watcher, its caller — covered separately.</summary>
public sealed class RefreshByKeysTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IRecordIndex Index => _mod.Index.Store!;

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    [Fact]
    public void ARefreshedKey_ShowsAHandEditAtTheWorkingTree_ThenAtTheCommittedRefOnceCommitted()
    {
        var formKey = _mod.Npc.ToString();
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        Index.RefreshByKeys(_mod.Plugin, _mod.ModFolder, [formKey]);

        Assert.Equal("RenamedByHand", Index.At(RecordRef.Effective).GetDocument(formKey, _mod.Plugin)!.EditorId);
        Assert.DoesNotContain(
            "RenamedByHand", Index.At(RecordRef.Head).GetDocument(formKey, _mod.Plugin)!.Body!, StringComparison.Ordinal);

        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");

        Index.RefreshByKeys(_mod.Plugin, _mod.ModFolder, [formKey]);

        var entry = Index.At(RecordRef.Effective).GetOverrideStack(formKey)!.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("RenamedByHand", entry.Head.EditorId);
    }

    [Fact]
    public void RefreshingAnUnchangedKey_AdvancesNoSequence()
    {
        var before = Index.Sequence;

        Index.RefreshByKeys(_mod.Plugin, _mod.ModFolder, [_mod.Npc.ToString()]);

        Assert.Equal(before, Index.Sequence);
    }

    [Fact]
    public void RefreshingADriftedKey_AdvancesTheSequence()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));
        var before = Index.Sequence;

        Index.RefreshByKeys(_mod.Plugin, _mod.ModFolder, [_mod.Npc.ToString()]);

        Assert.True(Index.Sequence > before);
    }

    [Fact]
    public void ARefreshedKeyTheIndexHasNeverSeen_LandsTheRecordTheTreeHasGained()
    {
        // A create's whole file side, made without the write API: the document is in the tree and
        // nothing has told the Index about it.
        var formKey = "000F00:Fixture.esp";
        var body = File.ReadAllText(_mod.NpcSourceFile)
            .Replace(_mod.Npc.ToString(), formKey, StringComparison.Ordinal)
            .Replace("\"FixtureNpc\"", "\"HandCreated\"", StringComparison.Ordinal);
        File.WriteAllText(_mod.SourceFileFor(FormKey.Factory(formKey), "npc_", "HandCreated"), body);

        Index.RefreshByKeys(_mod.Plugin, _mod.ModFolder, [formKey]);

        // A document alone cannot say where the tree puts a record, so the copy is re-derived whole
        // — and the record, its identity row and its EditorID all arrive with it.
        Assert.Equal("HandCreated", Index.At(RecordRef.Effective).GetDocument(formKey, _mod.Plugin)?.EditorId);
        Assert.Contains(formKey, Index.At(RecordRef.Effective).GetNativeFormKeys(_mod.Plugin));
        // Never committed, so it answers at Effective and nowhere else.
        Assert.Null(Index.At(RecordRef.Head).GetDocument(formKey, _mod.Plugin));
    }

    [Fact]
    public void ARefreshedKeyWhoseDocumentIsNotReadable_LeavesItsRowsAsTheyStand()
    {
        var formKey = _mod.Npc.ToString();
        var before = Index.At(RecordRef.Effective).GetDocument(formKey, _mod.Plugin)!.Body;

        // Mid-save, or hand-edited into something that is not a document at all: never assume
        // exclusive ownership of the file.
        File.WriteAllText(_mod.NpcSourceFile, "{ this is not json");

        Index.RefreshByKeys(_mod.Plugin, _mod.ModFolder, [formKey]);

        Assert.Equal(before, Index.At(RecordRef.Effective).GetDocument(formKey, _mod.Plugin)!.Body);
    }
}
