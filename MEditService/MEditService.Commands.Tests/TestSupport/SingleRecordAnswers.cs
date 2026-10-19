using MEditService.Commands.Edits;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Tests.TestSupport;

internal static class SingleRecordAnswers
{
    /// <summary>What an edit answered, as the outcome the tests read.</summary>
    internal static RecordEditResult AsResult(this Answer<EditRecordChanges, RecordEditRefused> answer) =>
        answer.Holds(out var changes, out var refused)
            ? new RecordEditResult(true, RecordEditRefusal.None, "", changes.NewFormKey)
            : Refusing(refused);

    /// <summary>What a create answered, as the outcome the tests read.</summary>
    internal static RecordEditResult AsResult(this Answer<CreateRecordChanges, RecordEditRefused> answer) =>
        answer.Holds(out var changes, out var refused)
            ? new RecordEditResult(true, RecordEditRefusal.None, "", changes.FormKey)
            : Refusing(refused);

    /// <summary>What a script's write answered, as the outcome the tests read.</summary>
    internal static RecordEditResult AsResult(this Answer<RecordWritten, RecordEditRefused> answer) =>
        answer.Holds(out var written, out var refused)
            ? new RecordEditResult(true, RecordEditRefusal.None, "", written.FormKey)
            : Refusing(refused);

    private static RecordEditResult Refusing(RecordEditRefused refused) =>
        new(false, refused.Refusal, refused.Message, Path: refused.Path);

    /// <summary>The outcome, and the changes it made: none when it was refused.</summary>
    internal static (RecordEditResult Outcome, EditRecordChanges? Changes) Seen(this Answer<EditRecordChanges, RecordEditRefused> answer) =>
        (answer.AsResult(), answer.Holds(out var changes, out _) ? changes : null);

    internal static void Deconstruct(
        this Answer<EditRecordChanges, RecordEditRefused> answer, out RecordEditResult outcome, out EditRecordChanges? changes) =>
        (outcome, changes) = answer.Seen();

    internal static void Deconstruct(
        this Answer<CreateRecordChanges, RecordEditRefused> answer, out RecordEditResult outcome, out CreateRecordChanges? changes) =>
        (outcome, changes) = (answer.AsResult(), answer.Holds(out var made, out _) ? made : null);
}
