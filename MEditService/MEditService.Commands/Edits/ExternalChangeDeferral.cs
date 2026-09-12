using MEditService.SourceRepo;

namespace MEditService.Commands.Edits;

/// <summary>An unanswered external-change question refuses every write to the mod, compile included
/// (ADR-0003). The marker caches the classifier's verdict, which alone decides: a present
/// marker is classified again, and nothing found clears it.</summary>
public static class ExternalChangeDeferral
{
    /// <summary><paramref name="question"/> is the exact user-facing message a refused edit gets back, so
    /// the signposting names the real unanswered question rather than a generic "try again later".</summary>
    public static void Set(string modFolder, string question) =>
        SourceRepository.RaiseExternalChangeQuestion(modFolder, question);

    /// <summary>Answering for the mod clears every plugin it holds at once. Also the write gate's, a
    /// settle's and a load's call on a verdict of nothing: the marker never outlives the change it
    /// names.</summary>
    public static void Clear(string modFolder) => SourceRepository.ClearExternalChangeQuestion(modFolder);

    /// <summary>The question's message as last raised, or null. Non-null is a reason to classify,
    /// not yet a reason to refuse.</summary>
    public static string? Unanswered(string modFolder) => SourceRepository.UnansweredExternalChange(modFolder);
}
