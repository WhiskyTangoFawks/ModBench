using System.Diagnostics.CodeAnalysis;
using MEditService.PluginAdapter;

namespace MEditService.Commands.Resolution;

/// <summary>What a copy reads of its source (ADR-0019): the value, or the reader's own words for why
/// the source cannot be read.</summary>
internal abstract class CopyRead<T>
{
    private CopyRead()
    {
    }

    public static implicit operator CopyRead<T>(T value) => new Read(value);

    internal static CopyRead<T> Unreadable(string why) => new Unread(why);

    /// <summary>The plugin adapter's answer, its failure in its own words.</summary>
    internal static CopyRead<T> Of(PluginAnswer<T> answer) =>
        answer.Holds(out var value, out var failure) ? new Read(value) : new Unread(failure.Reason);

    internal abstract bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out string? why);

    /// <summary>The value <paramref name="next"/> reads from this one, or this one's reason.</summary>
    internal CopyRead<TNext> Then<TNext>(Func<T, CopyRead<TNext>> next) =>
        Holds(out var value, out var why) ? next(value) : CopyRead<TNext>.Unreadable(why);

    private sealed class Read(T read) : CopyRead<T>
    {
        internal override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out string? why)
        {
            (value, why) = (read, null);
            return true;
        }
    }

    private sealed class Unread(string reason) : CopyRead<T>
    {
        internal override bool Holds([MaybeNullWhen(false)] out T value, [NotNullWhen(false)] out string? why)
        {
            (value, why) = (default, reason);
            return false;
        }
    }
}
