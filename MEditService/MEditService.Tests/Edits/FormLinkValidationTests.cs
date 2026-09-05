using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>The FormLink check reads effective state: a record the working tree has deleted still
/// exists at Head, so a check against committed state would let a link point at something that
/// will not be there when this compiles.</summary>
public sealed class FormLinkValidationTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // `keywords` rather than a bare FormLink column, because an array of FormLinks is also the atomic
    // complex-field write: the whole field, never one element. A top-level scalar FormLink column has
    // its own coverage.
    private RecordEditResult SetKeywords(params string[] formKeys) =>
        Service().Set(_mod.Plugin, _mod.Npc.ToString(), "Keywords", Json(JsonSerializer.Serialize(formKeys)));

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
        // The record still exists at Head — `git show` would print it. What it is not is somewhere a link
        // can point: exactly the divergence "checks read effective state" means.
        File.Delete(_mod.SourceFileFor(_mod.Keyword, "kywd", TrackedModFixture.KeywordEditorId));
        _mod.Mirror.Index!.ApplyWorkingTreeChanges(_mod.Plugin, [(_mod.Keyword.ToString(), null)]);

        Assert.NotEmpty(_mod.GitShowHead(_mod.RelativeSourcePath(_mod.Keyword, "kywd", TrackedModFixture.KeywordEditorId)));

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
