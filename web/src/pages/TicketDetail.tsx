import { Link, useNavigate, useParams } from 'react-router-dom';
import { TicketView } from './TicketView.tsx';

/**
 * The canonical page for one ticket. The list opens the same view in a drawer;
 * this route stays the entry point a deep link, a bookmark, or an API caller
 * lands on.
 */
export function TicketDetailPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const navigate = useNavigate();

  return (
    <>
      <div className="row back-row">
        <Link to="/" className="small">
          ← 返回列表
        </Link>
      </div>
      <TicketView id={id} onDeleted={() => navigate('/')} />
    </>
  );
}
