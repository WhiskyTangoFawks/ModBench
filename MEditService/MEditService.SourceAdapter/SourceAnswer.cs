using System.Diagnostics.CodeAnalysis;

namespace MEditService.SourceAdapter;

/// <summary>What a read or write of a plugin's source answers (ADR-0019): its value, or why it stopped.</summary>
public abstract class SourceAnswer<T>
{
    private SourceAnswer()
    {
    }

    internal static SourceAnswer<T> Of(T value) => new Answered(value);

    public static implicit operator SourceAnswer<T>(SourceFailure failure) => new Failed(failure);

    public static implicit operator SourceAnswer<T>(T value) => new Answered(value);

    public abstract bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out SourceFailure? failure);

    /// <summary>What <paramref name="next"/> answers of this value, or this answer's failure.</summary>
    public SourceAnswer<TNext> Then<TNext>(Func<T, SourceAnswer<TNext>> next) =>
        Holds(out var value, out var failure) ? next(value) : failure;

    private sealed class Answered(T answer) : SourceAnswer<T>
    {
        public override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out SourceFailure? failure)
        {
            (value, failure) = (answer, null);
            return true;
        }
    }

    private sealed class Failed(SourceFailure stopped) : SourceAnswer<T>
    {
        public override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out SourceFailure? failure)
        {
            (value, failure) = (default, stopped);
            return false;
        }
    }
}

/// <summary>Builds the answers <see cref="SourceAnswer{T}"/> carries.</summary>
public static class SourceAnswer
{
    public static SourceAnswer<T> Of<T>(T value) => SourceAnswer<T>.Of(value);
}

/// <summary>Why a read or write of a plugin's source stopped, in the words a refusal or a status names
/// it by.</summary>
public abstract record SourceFailure
{
    private SourceFailure(string reason) => Reason = reason;

    public string Reason { get; }

    /// <summary>A file filed as a record document is not one this reader can read.</summary>
    public sealed record Unreadable : SourceFailure
    {
        internal Unreadable(string reason, UnreadableFile? file) : base(reason) => File = file;

        /// <summary>The file that could not be read, when one is known.</summary>
        public UnreadableFile? File { get; }
    }

    /// <summary>More than one document claims one record, so no one of them is its document.</summary>
    public sealed record Ambiguous : SourceFailure
    {
        internal Ambiguous(string reason, ClaimedFormKey? claim) : base(reason) => Claim = claim;

        /// <summary>The FormKey and the documents that claim it, when they are known.</summary>
        public ClaimedFormKey? Claim { get; }
    }

    /// <summary>The tree holds no document carrying the record a write needs.</summary>
    public sealed record NotCarried : SourceFailure
    {
        // A defect reads identically to another tool's change, and a wrong explanation sends the user hunting a
        // problem that is not there, so this blames neither.
        public const string DefectOrOutsideChange =
            "If nothing outside Modbench changed that file, this is a defect — please report it; otherwise relaunch mEdit " +
            "so the index re-reads the tree.";

        internal const string MovedOrRemovedOutside = "It was moved or removed outside Modbench. Check the Source Control panel.";

        internal NotCarried(string reason) : base(reason)
        {
        }

        /// <summary>The words for a document found holding a record whose own text does not carry it.</summary>
        public static string FoundButNotCarried(string relativePath, string formKey) =>
            $"{relativePath} was found holding {formKey}, but its own text does not carry it. {DefectOrOutsideChange}";
    }

    /// <summary>git cannot be run (ADR-0007).</summary>
    public sealed record GitUnavailable : SourceFailure
    {
        internal GitUnavailable()
            : base("git was not found on PATH. Modbench's tracking features require git to be installed and on PATH.")
        {
        }
    }

    /// <summary>git ran and refused: a state of the repository.</summary>
    public sealed record GitFailed : SourceFailure
    {
        internal GitFailed(string reason) : base(reason)
        {
        }
    }

    /// <summary>The file system would not give a read or write what it needs: a file or folder is gone,
    /// another program holds it, or access is denied.</summary>
    public sealed record Inaccessible : SourceFailure
    {
        internal Inaccessible(string reason, Exception? error) : base(reason) => Error = error;

        /// <summary>The throw that stopped the read or write, for the log.</summary>
        public Exception? Error { get; }
    }

    /// <summary>The failure <paramref name="ex"/> stands for, or null for a throw that is a defect, which
    /// propagates.</summary>
    internal static SourceFailure? Of(Exception ex) => ex switch
    {
        SourceStopException stop => stop.Failure,
        IOException or UnauthorizedAccessException => new Inaccessible(ex.Message, ex),
        _ => null,
    };

    /// <summary><paramref name="read"/>'s value, or the failure its throw stands for.</summary>
    internal static SourceAnswer<T> Answer<T>(Func<T> read)
    {
        try
        {
            return SourceAnswer<T>.Of(read());
        }
        catch (Exception ex) when (Of(ex) is { } failure)
        {
            return failure;
        }
    }

    /// <summary>Null when <paramref name="act"/> ran through, else the failure its throw stands for.</summary>
    internal static SourceFailure? Answer(Action act)
    {
        try
        {
            act();
            return null;
        }
        catch (Exception ex) when (Of(ex) is { } failure)
        {
            return failure;
        }
    }
}

/// <summary>Unwinds a read or write of the tree to the verb that answers its failure. Never leaves this
/// adapter.</summary>
internal sealed class SourceStopException : InvalidOperationException
{
    private SourceStopException(SourceFailure failure, Exception? cause = null) : base(failure.Reason, cause) => Failure = failure;

    // RCS1194's standard constructors, which nothing calls: every stop carries its failure.
    internal SourceStopException() : this(string.Empty)
    {
    }

    internal SourceStopException(string message) : this(new SourceFailure.Unreadable(message, null))
    {
    }

    internal SourceStopException(string message, Exception innerException) : base(message, innerException) =>
        Failure = new SourceFailure.Unreadable(message, null);

    internal SourceFailure Failure { get; }

    internal static SourceStopException Of(SourceFailure failure) => new(failure);

    internal static SourceStopException Unreadable(string reason) => new(new SourceFailure.Unreadable(reason, null));

    internal static SourceStopException Unreadable(UnreadableFile file) => new(new SourceFailure.Unreadable(file.Message, file));

    /// <summary>A file filed as a record in the tree under <paramref name="modFolder"/> that cannot be read
    /// <paramref name="because"/>.</summary>
    internal static SourceStopException UnreadableIn(string modFolder, string file, string because, string? formKey = null) =>
        Unreadable(new UnreadableFile(
            Path.GetRelativePath(modFolder, file),
            $"'{file}' is filed as a record in this plugin's source tree, but {because}.",
            formKey));

    internal static SourceStopException Ambiguous(string reason) => new(new SourceFailure.Ambiguous(reason, null));

    internal static SourceStopException Ambiguous(ClaimedFormKey claim) => new(new SourceFailure.Ambiguous(claim.Message, claim));

    internal static SourceStopException NotCarried(string reason) => new(new SourceFailure.NotCarried(reason));

    internal static SourceStopException GitUnavailable(Exception? cause = null) => new(new SourceFailure.GitUnavailable(), cause);

    internal static SourceStopException GitFailed(string reason) => new(new SourceFailure.GitFailed(reason));

    internal static SourceStopException Inaccessible(string reason, Exception? error = null) =>
        new(new SourceFailure.Inaccessible(reason, error));
}
