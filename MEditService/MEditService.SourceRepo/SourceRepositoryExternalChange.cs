namespace MEditService.SourceRepo;

/// <summary>The mod folder's record of one unanswered external-change question (ADR-0003). Where it
/// is written is the repository's answer; what the question says, and whether it still stands, is
/// the caller's.</summary>
public sealed partial class SourceRepository
{
    private const string ExternalChangeMarkerFileName = "MEDIT_EXTERNAL_CHANGE";

    private static string ExternalChangeMarkerPath(string modFolder) =>
        Path.Combine(modFolder, ".git", ExternalChangeMarkerFileName);

    /// <summary><paramref name="question"/> is the exact user-facing message a refused edit gets
    /// back. Nothing is written for an untracked folder: the repository vanished before this write
    /// reached it, and there is nowhere to persist to.</summary>
    public static void RaiseExternalChangeQuestion(string modFolder, string question)
    {
        if (!IsTracked(modFolder)) return;

        var path = ExternalChangeMarkerPath(modFolder);
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, question);
        File.Move(tempPath, path, overwrite: true);
    }

    /// <summary>Answering for the mod clears every plugin it holds at once, and clearing a folder
    /// with no question is not an error.</summary>
    public static void ClearExternalChangeQuestion(string modFolder)
    {
        var path = ExternalChangeMarkerPath(modFolder);
        if (File.Exists(path)) File.Delete(path);
    }

    /// <summary>The question's message as last raised, or null — never a throw for an untracked
    /// folder or a missing marker.</summary>
    public static string? UnansweredExternalChange(string modFolder)
    {
        var path = ExternalChangeMarkerPath(modFolder);
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }
}
