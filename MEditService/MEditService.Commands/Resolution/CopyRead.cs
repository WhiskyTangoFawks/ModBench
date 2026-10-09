using System.Diagnostics.CodeAnalysis;
using MEditService.Commands.Edits;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Resolution;

/// <summary>Why a copy could not read its source: the reader's own words, and the refusal whose way out
/// is the way out of what stopped it.</summary>
internal sealed record CopyUnread(string Why, RecordEditRefusal Kind);

/// <summary>What a copy reads of its source (ADR-0019): the value, or why the source cannot be read.</summary>
internal abstract class CopyRead<T>
{
    private CopyRead()
    {
    }

    public static implicit operator CopyRead<T>(T value) => new Read(value);

    /// <summary>A reader's words for text that is no record.</summary>
    internal static CopyRead<T> Unreadable(string why) => new Unread(new CopyUnread(why, RecordEditRefusal.RecordParseFailed));

    /// <summary>The plugin adapter's answer, its failure in its own words.</summary>
    internal static CopyRead<T> Of(Answer<T, PluginFailure> answer) =>
        answer.Holds(out var value, out var failure) ? new Read(value) : Unreadable(failure.Reason);

    /// <summary>The source adapter's answer, its failure in its own words and of its own kind.</summary>
    internal static CopyRead<T> Of(Answer<T, SourceFailure> answer) =>
        answer.Holds(out var value, out var failure)
            ? new Read(value)
            : new Unread(new CopyUnread(failure.Reason, WriteFailure.KindOf(failure)));

    internal abstract bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out CopyUnread? unread);

    /// <summary>The value <paramref name="next"/> reads from this one, or why this one could not be read.</summary>
    internal CopyRead<TNext> Then<TNext>(Func<T, CopyRead<TNext>> next) =>
        Holds(out var value, out var unread) ? next(value) : new CopyRead<TNext>.Unread(unread);

    private sealed class Read(T read) : CopyRead<T>
    {
        internal override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out CopyUnread? unread)
        {
            (value, unread) = (read, null);
            return true;
        }
    }

    private sealed class Unread(CopyUnread stopped) : CopyRead<T>
    {
        internal override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out CopyUnread? unread)
        {
            (value, unread) = (default, stopped);
            return false;
        }
    }
}
