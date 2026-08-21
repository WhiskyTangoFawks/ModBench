using System.Text.Json;
using MEditService.Core.Edits;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #415 AC3: creating a Dangling or Type-Mismatched FormLink (CONTEXT.md — both always data errors)
/// is still blocked at edit time, and the check reads <b>effective</b> state. ADR-0020 kept, relocated:
/// the validation moment moved from staging to the working-tree write, but existence and type are
/// still checked before anything is persisted.
///
/// The effective-state half is the one worth being careful about. A record the working tree has
/// deleted still exists at Head, so a check that resolved against the committed state would happily
/// let the user point a link at something that will not be there when this compiles.
/// </summary>
public sealed class FormLinkValidationTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // `keywords` rather than a bare FormLink column, because a top-level FormLink column carries no
    // write delegate at all in the reflected schema (SchemaReflector: "read-only as a column,
    // ApplyFormLinkJson as a sub-field") — so it would refuse as FieldReadOnly long before any link
    // was validated, and prove nothing. An array of FormLinks is the writable form, and is also the
    // atomic complex-field write CONTEXT.md describes: the whole field, never one element.
    private RecordEditResult SetKeywords(params string[] formKeys) =>
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "keywords", Json(JsonSerializer.Serialize(formKeys)));

    [Fact]
    public void PointingAFormLinkAtARecordNoPluginHolds_IsRefusedAsDangling()
    {
        var result = SetKeywords("ABCDEF:NoSuchPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void PointingAFormLinkAtTheWrongRecordType_IsRefused()
    {
        // A RACE where the field's schema says KYWD — resolvable, so this is the type axis on its
        // own, not dangling wearing a different name.
        var result = SetKeywords(_mod.Race.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void PointingAFormLinkAtARecordOfTheRightType_IsAccepted()
    {
        // The positive control for both refusals above: the same field, the same code path, a valid
        // target — so neither refusal can be passing because this field is simply unwritable.
        var result = SetKeywords(_mod.Keyword.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.NotEmpty(_mod.GitStatus());
    }

    [Fact]
    public void ARecordDeletedInTheWorkingTree_IsAlreadyGoneForValidationPurposes()
    {
        // The record still exists at Head — it is in the last commit, and `git show` would print it.
        // What it no longer is, is somewhere a link can point: this is exactly the divergence AC3
        // means by "checks read effective state".
        File.Delete(_mod.SourceFileFor(_mod.Keyword, "kywd"));
        _mod.Sessions.Index!.ApplyWorkingTreeChanges(_mod.Plugin, [(_mod.Keyword.ToString(), null)]);

        Assert.NotEmpty(_mod.GitShowHead(TrackedModFixture.RelativeSourcePath(_mod.Keyword, "kywd")));

        var result = SetKeywords(_mod.Keyword.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.InvalidFormLink, result.Refusal);
    }

    [Fact]
    public void ARefusedFormLink_ExplainsWhichValueWasRejected()
    {
        var result = SetKeywords("ABCDEF:NoSuchPlugin.esp");

        // ADR-0026: a refusal the user cannot act on is dead UI. The message has to name the value,
        // not merely report that something was invalid.
        Assert.Contains("ABCDEF:NoSuchPlugin.esp", result.Message, StringComparison.OrdinalIgnoreCase);
    }
}
