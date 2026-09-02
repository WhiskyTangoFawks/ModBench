using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #677: a renumber's index update commits once or not at all. It is a sequence — materialize the
/// new identity's rows, re-point the folder-split children and exterior cells that still name the
/// old one, tear the old one down — and <see cref="IRecordIndex.ApplyRenumber"/> wraps the whole of
/// it in a single transaction, so a fault part-way leaves the index exactly as it found it.
///
/// <para><b>The fault is real, not injected.</b> A body the declared record type cannot parse
/// reaches the create step, which inserts the new row and <i>then</i> deserializes the body to
/// re-derive its lookup and reference rows — so it throws with its own insert already written, and
/// on the embedded path with the owner's row already moved too. That is the shape a mid-write
/// failure actually has, and producing it needs no seam in production: the earlier writes have to
/// disappear, or they did not roll back.</para>
///
/// <para><b>What this does not claim.</b> Not reader isolation: a read on the shared connection
/// genuinely does see this transaction's uncommitted rows while it is open, which
/// <see cref="Records.DuckDbConnectionIsolationTests"/> pins as that connection's actual behaviour,
/// and which is not a defect — transparency mid-write is fine, dirt left behind after a failure is
/// not. Nothing here forbids a reader from seeing an intermediate state.</para>
///
/// <para><b>The rival</b> is the pre-#677 implementation: these writes made as separate index calls
/// from <c>WriteTargetRewrite</c>, two of them (the re-points) opening no transaction at all.
/// Restored by dropping <c>ApplyRenumber</c>'s own <c>BeginTransaction</c>/<c>Commit</c> so each
/// write auto-commits as it did then, both tests below fail — see each one's own note for how.</para>
///
/// <para>Driven at the index seam rather than through <c>RecordEditService.RenumberRecord</c>: the
/// service's own renumber tests (<see cref="ContainmentRederivationTests"/>,
/// <see cref="WorldspaceRenumberContainmentTests"/>) already pin that it asks for exactly this
/// update, and only from here can the update be handed a body that fails inside it.</para>
/// </summary>
public sealed class RenumberIndexAtomicityTests : IDisposable
{
    // Free at both refs in ContainerModFixture's plugin.
    private static readonly string NewFormKey =
        FormKey.Factory($"000F00:{ContainerModFixture.PluginName}").ToString();

    // Valid JSON, and nothing the codec can rebuild a record from.
    private const string UnparseableBody = """{ "not": "a record" }""";

    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private IRecordIndex Index => _fixture.Mirror.Index!;
    private IRecordReads Effective => Index.At(RecordRef.Effective);

    /// <summary>
    /// The shape with a source file of its own — a Quest, whose folder-split DialogTopics are what
    /// the <c>container_child</c> re-point exists to carry. The create step's own insert must not
    /// outlive the failure of the step it was part of.
    ///
    /// <para>Rival: <c>System.ArgumentException : Malformed FormKey string: a record</c>, thrown out
    /// of the very next read. The insert survived, so the index now holds a row for the new identity
    /// carrying the body that could not be parsed — and reading it back is what trips, since a typed
    /// read reconstitutes through the codec (ADR-0005). Worse than a wrong answer: unreadable.</para>
    /// </summary>
    [Fact]
    public void AFaultInsideRenumbersCreateStep_LeavesNoRowForTheNewIdentity()
    {
        var quest = _fixture.Quest.ToString();
        var before = Snapshot(quest);

        Assert.ThrowsAny<Exception>(() => Index.ApplyRenumber(
            _fixture.Plugin,
            new RenumberedRecord(quest, NewFormKey, RecordTypeOf(quest), UnparseableBody)));

        Assert.Null(Effective.GetDocument(NewFormKey, _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Head).GetDocument(NewFormKey, _fixture.Plugin));
        Assert.Equal(before, Snapshot(quest));
    }

    /// <summary>
    /// The embedded shape, and the one that proves the transaction spans <i>steps</i> rather than
    /// merely wrapping one: the owner's row is rewritten before the create step runs, so when the
    /// create fails that earlier write has to disappear with it.
    ///
    /// <para>Rival: <c>Assert.Equal() Failure: Strings differ … Expected: "EditorID": "TempRef"
    /// Actual: "EditorID": "TempRefRenamed"</c> — the owner's row kept the bytes the abandoned
    /// renumber gave it.</para>
    /// </summary>
    [Fact]
    public void AFaultInsideRenumbersCreateStep_AlsoUndoesTheOwnerRowWrittenBeforeIt()
    {
        var placedRef = _fixture.TemporaryRef.ToString();
        var owner = _fixture.EmbedCell.ToString();
        var ownerBefore = Effective.GetDocument(owner, _fixture.Plugin)!.Body!;

        // A different but still parseable owner document, so "the owner's row did not move" is a
        // claim with something to distinguish it from "the owner's row was never asked to move".
        var ownerAfter = ownerBefore.Replace(
            ContainerModFixture.TemporaryRefEditorId, "TempRefRenamed", StringComparison.Ordinal);
        Assert.NotEqual(ownerBefore, ownerAfter);

        Assert.ThrowsAny<Exception>(() => Index.ApplyRenumber(
            _fixture.Plugin,
            new RenumberedRecord(
                placedRef, NewFormKey, RecordTypeOf(placedRef), UnparseableBody,
                new EmbeddingOwner(owner, ownerAfter))));

        Assert.Equal(ownerBefore, Effective.GetDocument(owner, _fixture.Plugin)!.Body);
        Assert.Null(Effective.GetDocument(NewFormKey, _fixture.Plugin));
        Assert.NotNull(Effective.GetDocument(placedRef, _fixture.Plugin));
    }

    private string RecordTypeOf(string formKey) =>
        Effective.GetDocument(formKey, _fixture.Plugin)!.RecordType;

    /// <summary>The renumbered record's own document plus the containment rows the two re-point
    /// steps move — enough that any of the sequence's writes surviving the failure shows up here.</summary>
    private string Snapshot(string formKey) =>
        $"{Effective.GetDocument(formKey, _fixture.Plugin)?.Body ?? "absent"}\n" +
        string.Join(",", Effective.GetContainerChildren(_fixture.Plugin, formKey)
            .Select(c => $"{c.SlotName}[{c.SlotIndex}]={c.ChildFormKey}")
            .OrderBy(s => s, StringComparer.Ordinal));
}
