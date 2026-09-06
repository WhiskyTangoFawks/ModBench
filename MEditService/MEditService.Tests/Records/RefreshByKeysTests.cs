using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.Edits;

namespace MEditService.Tests.Records;

/// <summary>ADR-0046: the Index's one projection verb, exercised directly through the seam rather
/// than through SourceFreshness — its first caller, covered separately.</summary>
public sealed class RefreshByKeysTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IRecordIndex Index => _mod.Mirror.Index!;

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
}
